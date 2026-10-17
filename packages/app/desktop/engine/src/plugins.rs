// Native plugins (VST3): scanned from the system folders, loaded and edited on the main thread, processed on the
// engine thread. The engine host JS reaches them through the `__native*` functions.
#![allow(non_snake_case)]

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::ptr;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;
use vst3::Steinberg::Vst::*;
use vst3::Steinberg::*;
use vst3::{Class, ComPtr, ComWrapper, Interface};

use crate::{request_main, MainRequest};

const MAX_BLOCK: usize = 128;
const STATE_MAGIC: &[u8; 4] = b"ODV3";

#[derive(Serialize)]
struct Notice {
    uuid: String,
    #[serde(rename = "type")]
    kind: &'static str,
    value: String,
}

static NOTICES: Mutex<Vec<Notice>> = Mutex::new(Vec::new());
static LOADED: Mutex<Vec<(u32, u32, Option<Loaded>)>> = Mutex::new(Vec::new());

fn notify(uuid: &str, kind: &'static str, value: impl Into<String>) {
    NOTICES.lock().unwrap().push(Notice { uuid: uuid.to_string(), kind, value: value.into() });
}

// plugin states the plugins saved themselves: the box write that follows must not load them back
static KNOWN_STATES: Mutex<Option<HashMap<String, Vec<u8>>>> = Mutex::new(None);
// saved states on their way to the studio, sent as binary messages: the uuid's 36 characters, then the state
static STATES: Mutex<Vec<(String, Vec<u8>)>> = Mutex::new(Vec::new());

fn is_known(uuid: &str, state: &[u8]) -> bool {
    KNOWN_STATES.lock().unwrap().as_ref().and_then(|known| known.get(uuid)).is_some_and(|known| known.as_slice() == state)
}

// The notices reach the studio on their own socket, written by this thread, never by the audio thread
pub fn serve_notices(mut socket: tungstenite::WebSocket<std::net::TcpStream>) {
    let _ = socket.get_ref().set_read_timeout(Some(std::time::Duration::from_millis(10)));
    println!("[plugins] studio connected");
    loop {
        let states = std::mem::take(&mut *STATES.lock().unwrap());
        for (uuid, state) in states {
            let mut message = uuid.into_bytes();
            message.extend_from_slice(&state);
            if socket.send(tungstenite::Message::Binary(message.into())).is_err() { return; }
        }
        let notices = std::mem::take(&mut *NOTICES.lock().unwrap());
        if !notices.is_empty() {
            let json = serde_json::to_string(&notices).unwrap();
            if socket.send(tungstenite::Message::Text(json.into())).is_err() { break; }
        }
        match socket.read() {
            Ok(tungstenite::Message::Text(text)) => scan_request(&text),
            Ok(tungstenite::Message::Close(_)) => break,
            Err(tungstenite::Error::Io(error)) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(_) => break,
            Ok(_) => {}
        }
    }
    println!("[plugins] studio disconnected");
}

#[derive(serde::Deserialize)]
struct ScanRequest {
    folders: Vec<String>,
    force: bool,
}

// scanning loads plugins in their own processes and can take seconds, so it runs on a thread of its own
fn scan_request(text: &str) {
    let Ok(ScanRequest { folders, force }) = serde_json::from_str::<ScanRequest>(text) else { return };
    std::thread::spawn(move || {
        let catalogue = crate::scan::run(&folders, force);
        notify("", "plugins", serde_json::to_string(&catalogue).unwrap());
    });
}

// ---------- COM objects the host implements ----------

struct Host;

impl Class for Host {
    type Interfaces = (IHostApplication,);
}

impl IHostApplicationTrait for Host {
    unsafe fn getName(&self, name: *mut String128) -> tresult {
        for (index, unit) in "openDAW".encode_utf16().chain(std::iter::once(0)).enumerate() {
            (*name)[index] = unit as TChar;
        }
        kResultOk
    }

    unsafe fn createInstance(&self, _cid: *mut TUID, _iid: *mut TUID, obj: *mut *mut c_void) -> tresult {
        *obj = ptr::null_mut();
        kNotImplemented
    }
}

struct Events {
    list: RefCell<Vec<Event>>,
}

impl Class for Events {
    type Interfaces = (IEventList,);
}

impl IEventListTrait for Events {
    unsafe fn getEventCount(&self) -> int32 {self.list.borrow().len() as int32}

    unsafe fn getEvent(&self, index: int32, event: *mut Event) -> tresult {
        match self.list.borrow().get(index as usize) {
            Some(found) => {
                *event = *found;
                kResultOk
            }
            None => kInvalidArgument,
        }
    }

    unsafe fn addEvent(&self, event: *mut Event) -> tresult {
        self.list.borrow_mut().push(*event);
        kResultOk
    }
}

struct Stream {
    data: RefCell<Vec<u8>>,
    position: Cell<usize>,
}

impl Class for Stream {
    type Interfaces = (IBStream,);
}

impl IBStreamTrait for Stream {
    unsafe fn read(&self, buffer: *mut c_void, count: int32, read: *mut int32) -> tresult {
        let data = self.data.borrow();
        let start = self.position.get().min(data.len());
        let count = (count.max(0) as usize).min(data.len() - start);
        ptr::copy_nonoverlapping(data.as_ptr().add(start), buffer as *mut u8, count);
        self.position.set(start + count);
        if !read.is_null() { *read = count as int32; }
        kResultOk
    }

    unsafe fn write(&self, buffer: *mut c_void, count: int32, written: *mut int32) -> tresult {
        let count = count.max(0) as usize;
        let mut data = self.data.borrow_mut();
        let start = self.position.get();
        if data.len() < start + count { data.resize(start + count, 0); }
        ptr::copy_nonoverlapping(buffer as *const u8, data.as_mut_ptr().add(start), count);
        self.position.set(start + count);
        if !written.is_null() { *written = count as int32; }
        kResultOk
    }

    unsafe fn seek(&self, position: int64, mode: int32, result: *mut int64) -> tresult {
        let base = match mode {
            1 => self.position.get() as i64,
            2 => self.data.borrow().len() as i64,
            _ => 0,
        };
        let next = (base + position).max(0) as usize;
        self.position.set(next);
        if !result.is_null() { *result = next as int64; }
        kResultOk
    }

    unsafe fn tell(&self, position: *mut int64) -> tresult {
        if !position.is_null() { *position = self.position.get() as int64; }
        kResultOk
    }
}

fn stream(data: Vec<u8>) -> ComWrapper<Stream> {
    ComWrapper::new(Stream { data: RefCell::new(data), position: Cell::new(0) })
}

// The parameter edits the plugin's editor made, handed from the main thread to the engine thread
#[derive(Default)]
pub struct Inbox {
    edits: Vec<(ParamID, f64)>,
    // the host's latest base values, shown in the plugin's editor
    to_gui: HashMap<ParamID, f64>,
}

type SharedInbox = Arc<Mutex<Inbox>>;

#[derive(Serialize, Clone)]
struct ParamInfo {
    id: u32,
    name: String,
    module: String,
    min: f64,
    max: f64,
    #[serde(rename = "defaultValue")]
    default_value: f64,
    value: f64,
    flags: u32,
}

// the flags of WclapParamInfo (CLAP), so the studio maps and filters both kinds alike
const PARAM_STEPPED: u32 = 1 << 0;
const PARAM_HIDDEN: u32 = 1 << 2;
const PARAM_READONLY: u32 = 1 << 3;
const PARAM_BYPASS: u32 = 1 << 4;
// a setDirty this close to a parameter edit belongs to that edit
const EDIT_SETTLE: std::time::Duration = std::time::Duration::from_millis(300);

fn wide(text: &[TChar]) -> String {
    String::from_utf16_lossy(&text.iter().take_while(|unit| **unit != 0).map(|unit| *unit as u16).collect::<Vec<_>>())
}

unsafe fn read_params(controller: &ComPtr<IEditController>) -> Vec<ParamInfo> {
    (0..controller.getParameterCount()).filter_map(|index| {
        let mut info: ParameterInfo = std::mem::zeroed();
        if controller.getParameterInfo(index, &mut info) != kResultOk { return None; }
        let max = if info.stepCount > 0 { info.stepCount as f64 } else { 1.0 };
        let mut flags = if info.stepCount > 0 { PARAM_STEPPED } else { 0 };
        if info.flags & ParameterInfo_::ParameterFlags_::kIsHidden != 0
            || info.flags & ParameterInfo_::ParameterFlags_::kCanAutomate == 0 { flags |= PARAM_HIDDEN; }
        if info.flags & ParameterInfo_::ParameterFlags_::kIsReadOnly != 0 { flags |= PARAM_READONLY; }
        if info.flags & ParameterInfo_::ParameterFlags_::kIsBypass != 0 { flags |= PARAM_BYPASS; }
        Some(ParamInfo {
            id: info.id, name: wide(&info.title), module: String::new(), min: 0.0, max,
            default_value: info.defaultNormalizedValue * max, value: controller.getParamNormalized(info.id) * max, flags
        })
    }).collect()
}

// JUCE alone adds 2080 hidden "MIDI CC" parameters, only the automatable ones reach the studio
fn automatable(params: &[ParamInfo]) -> Vec<ParamInfo> {
    params.iter().filter(|param| param.flags & (PARAM_HIDDEN | PARAM_READONLY) == 0).cloned().collect()
}

// Edits from the plugin's editor: a parameter edit goes to the processor and its parameter box, only a change outside
// the parameters (setDirty on its own) or a preset switch marks the state
struct ComponentHandler {
    handle: u32,
    uuid: String,
    inbox: SharedInbox,
    ranges: RefCell<HashMap<ParamID, f64>>,
    controller: RefCell<Option<ComPtr<IEditController>>>,
    gestures: Cell<i32>,
    last_edit: Cell<Option<Instant>>,
    // the host is loading a state into the plugin: its "values changed" restates that state, the boxes stay as they are
    applying: Cell<bool>,
}

impl Class for ComponentHandler {
    type Interfaces = (IComponentHandler, IComponentHandler2);
}

impl ComponentHandler {
    fn report(&self, id: ParamID, normalized: f64) {
        let Some(max) = self.ranges.borrow().get(&id).copied() else { return };
        self.inbox.lock().unwrap().edits.push((id, normalized));
        notify(&self.uuid, "param", format!("{id}:{}", normalized * max));
    }

    unsafe fn reread(&self, titles: bool) {
        let Some(controller) = self.controller.borrow().clone() else { return };
        let params = read_params(&controller);
        *self.ranges.borrow_mut() = params.iter().map(|param| (param.id, param.max)).collect();
        let params = automatable(&params);
        if titles { notify(&self.uuid, "params", serde_json::to_string(&params).unwrap()); }
        for param in &params { notify(&self.uuid, "param", format!("{}:{}", param.id, param.value)); }
    }
}

impl IComponentHandlerTrait for ComponentHandler {
    unsafe fn beginEdit(&self, _id: ParamID) -> tresult {
        guarded("beginEdit", || self.gestures.set(self.gestures.get() + 1));
        kResultOk
    }

    unsafe fn performEdit(&self, id: ParamID, value: ParamValue) -> tresult {
        guarded("performEdit", || {
            self.last_edit.set(Some(Instant::now()));
            self.report(id, value);
        });
        kResultOk
    }

    unsafe fn endEdit(&self, _id: ParamID) -> tresult {
        guarded("endEdit", || {
            self.gestures.set((self.gestures.get() - 1).max(0));
            self.last_edit.set(Some(Instant::now()));
        });
        kResultOk
    }

    unsafe fn restartComponent(&self, flags: int32) -> tresult {
        guarded("restartComponent", || {
            if self.applying.get() { return; }
            let titles = flags & RestartFlags_::kParamTitlesChanged != 0;
            if titles || flags & RestartFlags_::kParamValuesChanged != 0 {
                self.reread(titles);
                mark_dirty(self.handle);
            }
        });
        kResultOk
    }
}

impl IComponentHandler2Trait for ComponentHandler {
    unsafe fn setDirty(&self, state: TBool) -> tresult {
        guarded("setDirty", || {
            let editing = self.gestures.get() > 0 || self.last_edit.get().is_some_and(|at| at.elapsed() < EDIT_SETTLE);
            if state != 0 && !editing { mark_dirty(self.handle); }
        });
        kResultOk
    }

    unsafe fn requestOpenEditor(&self, _name: FIDString) -> tresult {kNotImplemented}
    unsafe fn startGroupEdit(&self) -> tresult {kResultOk}
    unsafe fn finishGroupEdit(&self) -> tresult {kResultOk}
}

// the host's parameter changes for one process call, a single point each at offset 0 (the engine splits the block at
// every change, so offset 0 is the change's exact sample)
struct ParamQueue {
    id: Cell<ParamID>,
    value: Cell<f64>,
}

impl Class for ParamQueue {
    type Interfaces = (IParamValueQueue,);
}

impl IParamValueQueueTrait for ParamQueue {
    unsafe fn getParameterId(&self) -> ParamID {self.id.get()}
    unsafe fn getPointCount(&self) -> int32 {1}

    unsafe fn getPoint(&self, index: int32, offset: *mut int32, value: *mut ParamValue) -> tresult {
        if index != 0 { return kInvalidArgument; }
        *offset = 0;
        *value = self.value.get();
        kResultOk
    }

    unsafe fn addPoint(&self, _offset: int32, _value: ParamValue, _index: *mut int32) -> tresult {kResultFalse}
}

struct ParamChanges {
    queues: Vec<(ComWrapper<ParamQueue>, ComPtr<IParamValueQueue>)>,
    count: Cell<usize>,
}

impl Class for ParamChanges {
    type Interfaces = (IParameterChanges,);
}

impl IParameterChangesTrait for ParamChanges {
    unsafe fn getParameterCount(&self) -> int32 {self.count.get() as int32}

    unsafe fn getParameterData(&self, index: int32) -> *mut IParamValueQueue {
        if index < 0 || index as usize >= self.count.get() { return ptr::null_mut(); }
        self.queues[index as usize].1.as_ptr()
    }

    unsafe fn addParameterData(&self, _id: *const ParamID, _index: *mut int32) -> *mut IParamValueQueue {ptr::null_mut()}
}

const MAX_PARAM_CHANGES: usize = 256;

fn param_changes() -> ComWrapper<ParamChanges> {
    let queues = (0..MAX_PARAM_CHANGES).map(|_| {
        let queue = ComWrapper::new(ParamQueue { id: Cell::new(0), value: Cell::new(0.0) });
        let pointer = queue.to_com_ptr::<IParamValueQueue>().unwrap();
        (queue, pointer)
    }).collect();
    ComWrapper::new(ParamChanges { queues, count: Cell::new(0) })
}

struct Frame {
    handle: u32,
}

impl Class for Frame {
    type Interfaces = (IPlugFrame,);
}

impl IPlugFrameTrait for Frame {
    unsafe fn resizeView(&self, view: *mut IPlugView, size: *mut ViewRect) -> tresult {
        guarded("resizeView", || {
            let (width, height) = ((*size).right - (*size).left, (*size).bottom - (*size).top);
            windows::resize(self.handle, width as f64, height as f64);
            if let Some(view) = ComRefView::new(view) { view.0.onSize(size); }
        });
        kResultOk
    }
}

struct ComRefView(ComPtr<IPlugView>);

impl ComRefView {
    unsafe fn new(raw: *mut IPlugView) -> Option<Self> {
        let view = ComPtr::from_raw(raw)?;
        let copy = view.clone();
        std::mem::forget(view);
        Some(Self(copy))
    }
}

// ---------- the plugin instance ----------

// the processing half, used by the engine thread
pub struct Processing {
    component: ComPtr<IComponent>,
    processor: ComPtr<IAudioProcessor>,
    events: ComWrapper<Events>,
    event_list: ComPtr<IEventList>,
    params: ComWrapper<ParamChanges>,
    param_list: ComPtr<IParameterChanges>,
    context: ProcessContext,
    outputs: i32,
}

pub struct Loaded {
    shared: Shared,
    inbox: SharedInbox,
    ranges: HashMap<ParamID, f64>,
}

unsafe impl Send for Processing {}

type Shared = Arc<Mutex<Processing>>;

pub(crate) struct Module {
    pub(crate) factory: ComPtr<IPluginFactory>,
    _library: libloading::Library,
    #[cfg(target_os = "macos")]
    _bundle: core_foundation::bundle::CFBundle,
}

// the editing half, main thread only. The list is never borrowed while a plugin is called: plugins call back
// into the host from almost any call (JUCE reports changes from inside setComponentState)
struct Editor {
    uuid: String,
    name: String,
    component: ComPtr<IComponent>,
    controller: ComPtr<IEditController>,
    shared: Shared,
    view: RefCell<Option<ComPtr<IPlugView>>>,
    // a plugin may change its parameters when its editor opens without telling the host (BA-1 loads its preset)
    reread_at: Cell<Option<Instant>>,
    inbox: SharedInbox,
    handler: ComWrapper<ComponentHandler>,
}

thread_local! {
    static MODULES: RefCell<HashMap<PathBuf, Rc<Module>>> = RefCell::new(HashMap::new());
    static EDITORS: RefCell<HashMap<u32, Rc<Editor>>> = RefCell::new(HashMap::new());
    static DIRTY: RefCell<std::collections::HashSet<u32>> = RefCell::new(std::collections::HashSet::new());
}

fn editor(handle: u32) -> Option<Rc<Editor>> {EDITORS.with(|editors| editors.borrow().get(&handle).cloned())}

fn all_editors() -> Vec<(u32, Rc<Editor>)> {
    EDITORS.with(|editors| editors.borrow().iter().map(|(handle, editor)| (*handle, editor.clone())).collect())
}

// a panic inside a callback a plugin made would abort the engine
fn guarded(label: &str, callback: impl FnOnce()) {
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(callback)).is_err() { eprintln!("[plugins] {label} panicked"); }
}

fn check(label: &str, result: tresult) -> bool {
    if result != kResultOk && result != kResultFalse { eprintln!("[plugins] {label}: result {result}"); }
    result == kResultOk
}

pub(crate) unsafe fn module(path: &Path) -> Option<Rc<Module>> {
    if let Some(module) = MODULES.with(|modules| modules.borrow().get(path).cloned()) { return Some(module); }
    #[cfg(not(target_os = "macos"))]
    let name = path.file_stem()?.to_string_lossy().to_string();
    #[cfg(target_os = "macos")]
    let (binary, bundle) = {
        use core_foundation::url::CFURL;
        let bundle = core_foundation::bundle::CFBundle::new(CFURL::from_path(path, true)?)?;
        (crate::scan::bundle_binary(path), bundle)
    };
    #[cfg(target_os = "windows")]
    let binary = path.join("Contents").join(if cfg!(target_arch = "aarch64") { "arm64-win" } else { "x86_64-win" }).join(format!("{name}.vst3"));
    #[cfg(target_os = "linux")]
    let binary = path.join("Contents").join(format!("{}-linux", std::env::consts::ARCH)).join(format!("{name}.so"));
    let library = libloading::Library::new(&binary).map_err(|error| eprintln!("[plugins] {}: {error}", binary.display())).ok()?;
    #[cfg(target_os = "macos")]
    {
        use core_foundation::base::TCFType;
        let entry: libloading::Symbol<unsafe extern "C" fn(*mut c_void) -> bool> = library.get(b"bundleEntry").ok()?;
        if !entry(bundle.as_concrete_TypeRef() as *mut c_void) { return None; }
    }
    #[cfg(target_os = "linux")]
    {
        let entry: libloading::Symbol<unsafe extern "C" fn(*mut c_void) -> bool> = library.get(b"ModuleEntry").ok()?;
        if !entry(ptr::null_mut()) { return None; }
    }
    #[cfg(target_os = "windows")]
    if let Ok(entry) = library.get::<unsafe extern "system" fn() -> bool>(b"InitDll") { entry(); }
    let get_factory: libloading::Symbol<unsafe extern "system" fn() -> *mut IPluginFactory> = library.get(b"GetPluginFactory").ok()?;
    let factory = ComPtr::from_raw(get_factory())?;
    let module = Rc::new(Module {
        factory,
        _library: library,
        #[cfg(target_os = "macos")]
        _bundle: bundle,
    });
    MODULES.with(|modules| modules.borrow_mut().insert(path.to_path_buf(), module.clone()));
    Some(module)
}

fn parse_cid(id: &str) -> Option<TUID> {
    if id.len() != 32 { return None; }
    let mut cid: TUID = [0; 16];
    for index in 0..16 {
        cid[index] = u8::from_str_radix(&id[index * 2..index * 2 + 2], 16).ok()? as i8 as _;
    }
    Some(cid)
}

unsafe fn create<T: Interface>(factory: &ComPtr<IPluginFactory>, cid: &TUID) -> Option<ComPtr<T>> {
    let mut object: *mut c_void = ptr::null_mut();
    check("createInstance", factory.createInstance(cid.as_ptr(), T::IID.as_ptr() as FIDString, &mut object));
    ComPtr::from_raw(object as *mut T)
}

// main thread
unsafe fn instantiate(handle: u32, uuid: &str, format: &str, id: &str, sample_rate: f64, state: Option<Vec<u8>>) -> Option<Loaded> {
    if format != "vst3" { return None; }
    let info = crate::scan::find(format, id)?;
    let _loading = crate::scan::Loading::new(&info.path);
    let module = module(Path::new(&info.path))?;
    let cid = parse_cid(id)?;
    let host = ComWrapper::new(Host);
    let host_unknown = host.to_com_ptr::<IHostApplication>()?.into_raw() as *mut FUnknown;
    let component: ComPtr<IComponent> = create(&module.factory, &cid)?;
    if !check("component.initialize", component.initialize(host_unknown)) { return None; }
    let controller: ComPtr<IEditController> = match component.cast::<IEditController>() {
        Some(controller) => controller,
        None => {
            let mut controller_cid: TUID = [0; 16];
            component.getControllerClassId(&mut controller_cid);
            let controller: ComPtr<IEditController> = create(&module.factory, &controller_cid)?;
            check("controller.initialize", controller.initialize(host_unknown));
            controller
        }
    };
    if let (Some(component_point), Some(controller_point)) = (component.cast::<IConnectionPoint>(), controller.cast::<IConnectionPoint>()) {
        component_point.connect(controller_point.as_ptr());
        controller_point.connect(component_point.as_ptr());
    }
    let inbox: SharedInbox = Arc::new(Mutex::new(Inbox::default()));
    let handler = ComWrapper::new(ComponentHandler {
        handle, uuid: uuid.to_string(), inbox: inbox.clone(), ranges: RefCell::new(HashMap::new()),
        controller: RefCell::new(Some(controller.clone())), gestures: Cell::new(0), last_edit: Cell::new(None),
        applying: Cell::new(false)
    });
    controller.setComponentHandler(handler.to_com_ptr::<IComponentHandler>()?.into_raw());
    // both are the host's own doing: the plugin's "values changed" during them restates what the host just set
    if let Some(state) = state {
        apply_state_quietly(&handler, &component, &controller, &state);
    } else {
        handler.applying.set(true);
        sync_controller(&component, &controller);
        handler.applying.set(false);
    }
    let processor = component.cast::<IAudioProcessor>()?;
    let audio_ins = component.getBusCount(MediaTypes_::kAudio as i32, BusDirections_::kInput as i32);
    let audio_outs = component.getBusCount(MediaTypes_::kAudio as i32, BusDirections_::kOutput as i32);
    let event_ins = component.getBusCount(MediaTypes_::kEvent as i32, BusDirections_::kInput as i32);
    let mut inputs = vec![SpeakerArr::kStereo; audio_ins as usize];
    let mut outputs = vec![SpeakerArr::kStereo; audio_outs as usize];
    processor.setBusArrangements(inputs.as_mut_ptr(), audio_ins, outputs.as_mut_ptr(), audio_outs);
    if audio_outs > 0 { component.activateBus(MediaTypes_::kAudio as i32, BusDirections_::kOutput as i32, 0, 1); }
    if event_ins > 0 { component.activateBus(MediaTypes_::kEvent as i32, BusDirections_::kInput as i32, 0, 1); }
    let mut setup = ProcessSetup {
        processMode: ProcessModes_::kRealtime as i32,
        symbolicSampleSize: SymbolicSampleSizes_::kSample32 as i32,
        maxSamplesPerBlock: MAX_BLOCK as i32,
        sampleRate: sample_rate,
    };
    if !check("setupProcessing", processor.setupProcessing(&mut setup)) { return None; }
    check("setActive", component.setActive(1));
    check("setProcessing", processor.setProcessing(1));
    let events = ComWrapper::new(Events { list: RefCell::new(Vec::with_capacity(64)) });
    let event_list = events.to_com_ptr::<IEventList>()?;
    let mut context: ProcessContext = std::mem::zeroed();
    context.sampleRate = sample_rate;
    context.timeSigNumerator = 4;
    context.timeSigDenominator = 4;
    let params = param_changes();
    let param_list = params.to_com_ptr::<IParameterChanges>()?;
    let shared = Arc::new(Mutex::new(Processing {
        component: component.clone(), processor, events, event_list, params, param_list, context, outputs: audio_outs.min(1)
    }));
    let infos = read_params(&controller);
    let ranges: HashMap<ParamID, f64> = infos.iter().map(|param| (param.id, param.max)).collect();
    *handler.ranges.borrow_mut() = ranges.clone();
    notify(uuid, "params", serde_json::to_string(&automatable(&infos)).unwrap());
    EDITORS.with(|editors| editors.borrow_mut().insert(handle, Rc::new(Editor {
        uuid: uuid.to_string(), name: info.name.clone(), component, controller, shared: shared.clone(), view: RefCell::new(None),
        reread_at: Cell::new(None), inbox: inbox.clone(), handler
    })));
    println!("[plugins] {} ready ({} {}, {} parameters)", info.name, info.vendor, id, infos.len());
    Some(Loaded { shared, inbox, ranges })
}

unsafe fn sync_controller(component: &ComPtr<IComponent>, controller: &ComPtr<IEditController>) {
    let saved = stream(Vec::new());
    if component.getState(saved.to_com_ptr::<IBStream>().unwrap().as_ptr()) == kResultOk {
        let data = saved.data.borrow().clone();
        let reader = stream(data);
        controller.setComponentState(reader.to_com_ptr::<IBStream>().unwrap().as_ptr());
    }
}

unsafe fn read_state(component: &ComPtr<IComponent>, controller: &ComPtr<IEditController>) -> Vec<u8> {
    let component_stream = stream(Vec::new());
    component.getState(component_stream.to_com_ptr::<IBStream>().unwrap().as_ptr());
    let controller_stream = stream(Vec::new());
    controller.getState(controller_stream.to_com_ptr::<IBStream>().unwrap().as_ptr());
    let (component_data, controller_data) = (component_stream.data.borrow(), controller_stream.data.borrow());
    let mut state = Vec::with_capacity(8 + component_data.len() + controller_data.len());
    state.extend_from_slice(STATE_MAGIC);
    state.extend_from_slice(&(component_data.len() as u32).to_le_bytes());
    state.extend_from_slice(&component_data);
    state.extend_from_slice(&controller_data);
    state
}

unsafe fn apply_state(component: &ComPtr<IComponent>, controller: &ComPtr<IEditController>, state: &[u8]) {
    if state.len() < 8 || &state[..4] != STATE_MAGIC { return; }
    let length = u32::from_le_bytes(state[4..8].try_into().unwrap()) as usize;
    let Some(component_data) = state.get(8..8 + length) else { return };
    let controller_data = &state[8 + length..];
    component.setState(stream(component_data.to_vec()).to_com_ptr::<IBStream>().unwrap().as_ptr());
    controller.setComponentState(stream(component_data.to_vec()).to_com_ptr::<IBStream>().unwrap().as_ptr());
    if !controller_data.is_empty() {
        controller.setState(stream(controller_data.to_vec()).to_com_ptr::<IBStream>().unwrap().as_ptr());
    }
}

unsafe fn apply_state_quietly(handler: &ComponentHandler, component: &ComPtr<IComponent>, controller: &ComPtr<IEditController>, state: &[u8]) {
    handler.applying.set(true);
    apply_state(component, controller, state);
    handler.applying.set(false);
}

fn mark_dirty(handle: u32) {
    guarded("mark_dirty", || DIRTY.with(|dirty| { dirty.borrow_mut().insert(handle); }));
}

// reading a state can block the plugin's processing, so it happens only when it is needed: closing the window, saving
// read on every save and window close: plugins do not always report a change (BA-1 loads its preset silently), an
// unchanged state is not sent again
fn save(handle: u32, editor: &Editor) {
    DIRTY.with(|dirty| dirty.borrow_mut().remove(&handle));
    let started = Instant::now();
    let state = unsafe { read_state(&editor.component, &editor.controller) };
    crate::stats::count(&crate::stats::STATE_READS);
    crate::stats::record_max(&crate::stats::MAX_STATE_US, started);
    let mut known = KNOWN_STATES.lock().unwrap();
    let known = known.get_or_insert_with(HashMap::new);
    if known.get(&editor.uuid) == Some(&state) { return; }
    known.insert(editor.uuid.clone(), state.clone());
    STATES.lock().unwrap().push((editor.uuid.clone(), state));
}

unsafe fn release_on_main(handle: u32) {
    let Some(editor) = EDITORS.with(|editors| editors.borrow_mut().remove(&handle)) else { return };
    DIRTY.with(|dirty| dirty.borrow_mut().remove(&handle));
    close_view(handle, &editor);
    editor.controller.setComponentHandler(ptr::null_mut());
    *editor.handler.controller.borrow_mut() = None;
    let processing = editor.shared.lock().unwrap();
    processing.processor.setProcessing(0);
    processing.component.setActive(0);
    drop(processing);
    if let (Some(component_point), Some(controller_point)) = (editor.component.cast::<IConnectionPoint>(), editor.controller.cast::<IConnectionPoint>()) {
        component_point.disconnect(controller_point.as_ptr());
        controller_point.disconnect(component_point.as_ptr());
    }
    editor.controller.terminate();
    editor.component.terminate();
}

unsafe fn close_view(handle: u32, editor: &Editor) {
    let view = editor.view.borrow_mut().take();
    if let Some(view) = view {
        view.setFrame(ptr::null_mut());
        view.removed();
        windows::close(handle);
        notify(&editor.uuid, "gui", "closed");
    }
}

// main thread, every few milliseconds: windows closed with their close button, the window level
const REREAD_DELAY: std::time::Duration = std::time::Duration::from_millis(500);

pub fn tick() {
    for (_, editor) in all_editors() {
        if editor.reread_at.get().is_some_and(|at| Instant::now() >= at) {
            editor.reread_at.set(None);
            unsafe { editor.handler.reread(false); }
        }
    }
    for (_, editor) in all_editors() { unsafe { flush_display(&editor); } }
    for handle in windows::closed() {
        if let Some(editor) = editor(handle) {
            unsafe { close_view(handle, &editor); }
            save(handle, &editor);
        }
    }
    windows::tick();
}

pub fn save_all() {
    request_main(MainRequest::Run(Box::new(|| {
        all_editors().iter().for_each(|(handle, editor)| save(*handle, editor));
        notify("", "saved", "");
    })));
}

pub fn cycle_in() {request_main(MainRequest::Run(Box::new(windows::cycle_in)));}

// the host's values for the editor display; a value the plugin already has is not written again
unsafe fn flush_display(editor: &Editor) {
    let values: Vec<(ParamID, f64)> = editor.inbox.lock().unwrap().to_gui.drain().collect();
    for (id, normalized) in values {
        if (editor.controller.getParamNormalized(id) - normalized).abs() < 1e-7 { continue; }
        editor.controller.setParamNormalized(id, normalized);
    }
}

unsafe fn open_view(handle: u32) {
    let Some(editor) = editor(handle) else { return };
    {
        if editor.view.borrow().is_some() {
            windows::front(handle);
            return;
        }
        // display values queued before must land before the editor exists, it may load a preset when it is created
        flush_display(&editor);
        let Some(view) = ComPtr::<IPlugView>::from_raw(editor.controller.createView(b"editor\0".as_ptr() as FIDString)) else {
            notify(&editor.uuid, "gui", "unavailable");
            return;
        };
        if view.isPlatformTypeSupported(windows::PLATFORM_TYPE) != kResultOk {
            notify(&editor.uuid, "gui", "unavailable");
            return;
        }
        let mut rect: ViewRect = std::mem::zeroed();
        view.getSize(&mut rect);
        let parent = windows::open(handle, &editor.name, (rect.right - rect.left) as f64, (rect.bottom - rect.top) as f64);
        let frame = ComWrapper::new(Frame { handle });
        view.setFrame(frame.to_com_ptr::<IPlugFrame>().unwrap().into_raw());
        if view.attached(parent, windows::PLATFORM_TYPE) != kResultOk {
            windows::close(handle);
            notify(&editor.uuid, "gui", "unavailable");
            return;
        }
        *editor.view.borrow_mut() = Some(view);
        editor.handler.reread(false);
        editor.reread_at.set(Some(Instant::now() + REREAD_DELAY));
        notify(&editor.uuid, "gui", "open");
    }
}

// ---------- engine thread ----------

struct Slot {
    uuid: String,
    generation: u32,
    format: String,
    id: String,
    shared: Option<Shared>,
    notes: Vec<(bool, i16, f32)>,
    state: Option<Vec<u8>>,
    known_state: Option<Vec<u8>>,
    inbox: Option<SharedInbox>,
    ranges: HashMap<ParamID, f64>,
    // host values that arrived before the plugin was ready, the boxes win over the saved state
    pending: HashMap<ParamID, (u32, f32, f32)>,
    // normalized values for the next process call
    changes: HashMap<ParamID, f64>,
    // what the plugin's editor last set, its box writing it back is no change
    reported: HashMap<ParamID, f32>,
    // the latest modulation of each parameter (plain units), added to an edit from the plugin's editor
    modulation: HashMap<ParamID, f64>,
    // an edit from the plugin's editor is the base until its box confirms it, host values with the old base use it
    edits: HashMap<ParamID, (f64, Instant)>,
}

thread_local! {
    static SLOTS: RefCell<HashMap<u32, Slot>> = RefCell::new(HashMap::new());
    static NEXT: Cell<u32> = const { Cell::new(1) };
}

pub fn create_slot(uuid: String) -> u32 {
    let handle = NEXT.with(|next| {
        let handle = next.get();
        next.set(handle + 1);
        handle
    });
    SLOTS.with(|slots| slots.borrow_mut().insert(handle, Slot {
        uuid, generation: 0, format: String::new(), id: String::new(), shared: None, notes: Vec::new(),
        state: None, known_state: None, inbox: None, ranges: HashMap::new(), pending: HashMap::new(),
        changes: HashMap::new(), reported: HashMap::new(), modulation: HashMap::new(), edits: HashMap::new()
    }));
    handle
}

pub fn load(handle: u32, format: String, id: String, sample_rate: f64) {
    SLOTS.with(|slots| {
        let mut slots = slots.borrow_mut();
        let Some(slot) = slots.get_mut(&handle) else { return };
        if slot.format == format && slot.id == id { return; }
        slot.format = format.clone();
        slot.id = id.clone();
        slot.generation += 1;
        if let Some(previous) = slot.shared.take() { release_shared(handle, previous); }
        slot.inbox = None;
        slot.ranges.clear();
        slot.changes.clear();
        slot.reported.clear();
        slot.modulation.clear();
        slot.edits.clear();
        if format.is_empty() || id.is_empty() { return; }
        let (generation, uuid) = (slot.generation, slot.uuid.clone());
        let state = slot.state.clone().filter(|state| !state.is_empty());
        slot.known_state = slot.state.clone();
        notify(&uuid, "status", "loading");
        request_main(MainRequest::Run(Box::new(move || {
            let shared = unsafe { instantiate(handle, &uuid, &format, &id, sample_rate, state) };
            notify(&uuid, "status", if shared.is_some() { "ready" } else { "failed" });
            LOADED.lock().unwrap().push((handle, generation, shared));
        })));
    });
}

const PARAM_KIND_UNIT: u32 = 0;

pub fn param(handle: u32, id: ParamID, kind: u32, value: f32, modulation: f32) {
    SLOTS.with(|slots| {
        if let Some(slot) = slots.borrow_mut().get_mut(&handle) {
            if slot.shared.is_none() {
                slot.pending.insert(id, (kind, value, modulation));
            } else {
                queue_param(slot, id, kind, value, modulation);
            }
        }
    });
}

const EDIT_CONFIRM: std::time::Duration = std::time::Duration::from_secs(1);

fn queue_param(slot: &mut Slot, id: ParamID, kind: u32, raw: f32, sum: f32) {
    let Some(max) = slot.ranges.get(&id).copied() else { return };
    let mut base = if kind == PARAM_KIND_UNIT { raw as f64 * max } else { raw as f64 };
    let modulation = if sum.is_nan() { 0.0 } else { sum as f64 * max };
    slot.modulation.insert(id, modulation);
    if let Some((edited, at)) = slot.edits.get(&id).copied() {
        if base as f32 == edited as f32 || at.elapsed() >= EDIT_CONFIRM {
            slot.edits.remove(&id);
        } else {
            base = edited;
        }
    }
    if modulation == 0.0 && slot.reported.get(&id) == Some(&(base as f32)) { return; }
    slot.changes.insert(id, ((base + modulation) / max).clamp(0.0, 1.0));
    if let Some(inbox) = slot.inbox.as_ref() {
        if let Ok(mut inbox) = inbox.try_lock() { inbox.to_gui.insert(id, (base / max).clamp(0.0, 1.0)); }
    }
}

fn release_shared(handle: u32, shared: Shared) {
    request_main(MainRequest::Run(Box::new(move || {
        unsafe { release_on_main(handle); }
        drop(shared);
    })));
}

pub fn set_state(handle: u32, state: Vec<u8>) {
    SLOTS.with(|slots| {
        let mut slots = slots.borrow_mut();
        let Some(slot) = slots.get_mut(&handle) else { return };
        if is_known(&slot.uuid, &state) { slot.known_state = Some(state.clone()); }
        let unchanged = slot.known_state.as_deref() == Some(state.as_slice());
        slot.state = Some(state.clone());
        if unchanged || slot.shared.is_none() || state.is_empty() { return; }
        apply_later(handle, slot, state);
    });
}

fn apply_later(handle: u32, slot: &mut Slot, bytes: Vec<u8>) {
    slot.known_state = Some(bytes.clone());
    request_main(MainRequest::Run(Box::new(move || {
        if let Some(editor) = editor(handle) {
            unsafe { apply_state_quietly(&editor.handler, &editor.component, &editor.controller, &bytes); }
        }
    })));
}

pub fn note(handle: u32, on: bool, key: i16, velocity: f32) {
    SLOTS.with(|slots| {
        if let Some(slot) = slots.borrow_mut().get_mut(&handle) { slot.notes.push((on, key, velocity)); }
    });
}

pub fn reset(handle: u32) {
    SLOTS.with(|slots| {
        if let Some(slot) = slots.borrow_mut().get_mut(&handle) { slot.notes.clear(); }
    });
}

pub fn release(handle: u32) {
    SLOTS.with(|slots| {
        if let Some(mut slot) = slots.borrow_mut().remove(&handle) {
            if let Some(shared) = slot.shared.take() { release_shared(handle, shared); }
        }
    });
}

pub fn handle_of(uuid: &str) -> Option<u32> {
    SLOTS.with(|slots| slots.borrow().iter().find(|(_, slot)| slot.uuid == uuid).map(|(handle, _)| *handle))
}

pub fn open_gui(handle: u32) {request_main(MainRequest::Run(Box::new(move || unsafe { open_view(handle) })));}

pub fn close_gui(handle: u32) {
    request_main(MainRequest::Run(Box::new(move || {
        if let Some(editor) = editor(handle) {
            unsafe { close_view(handle, &editor); }
            save(handle, &editor);
        }
    })));
}

const FLAG_PLAYING: u32 = 1 << 2;

fn take_loaded() {
    let loaded = std::mem::take(&mut *LOADED.lock().unwrap());
    SLOTS.with(|slots| {
        let mut slots = slots.borrow_mut();
        for (handle, generation, shared) in loaded {
            match (slots.get_mut(&handle), shared) {
                (Some(slot), Some(Loaded { shared, inbox, ranges })) if slot.generation == generation => {
                    slot.shared = Some(shared);
                    slot.inbox = Some(inbox);
                    slot.ranges = ranges;
                    for (id, (kind, value, modulation)) in std::mem::take(&mut slot.pending) {
                        queue_param(slot, id, kind, value, modulation);
                    }
                    // a state that arrived while the plugin was loading
                    if slot.state != slot.known_state {
                        if let Some(state) = slot.state.clone() { apply_later(handle, slot, state); }
                    }
                }
                (_, Some(loaded)) => release_shared(handle, loaded.shared),
                _ => {}
            }
        }
    });
}

// writes `frames` into the two channel pointers; false while the plugin is not ready (the device adds nothing)
pub unsafe fn process(handle: u32, left: *mut f32, right: *mut f32, frames: usize, bpm: f32, position: f64, flags: u32) -> bool {
    take_loaded();
    SLOTS.with(|slots| {
        let mut slots = slots.borrow_mut();
        let Some(slot) = slots.get_mut(&handle) else { return false };
        let Some(shared) = slot.shared.as_ref() else { return false };
        if let Some(inbox) = slot.inbox.as_ref() {
            if let Ok(mut inbox) = inbox.try_lock() {
                for (id, normalized) in inbox.edits.drain(..) {
                    let max = slot.ranges.get(&id).copied().unwrap_or(1.0);
                    let base = normalized * max;
                    let modulation = slot.modulation.get(&id).copied().unwrap_or(0.0);
                    slot.reported.insert(id, base as f32);
                    slot.edits.insert(id, (base, Instant::now()));
                    slot.changes.insert(id, ((base + modulation) / max).clamp(0.0, 1.0));
                }
            }
        }
        let Ok(mut processing) = shared.try_lock() else {
            crate::stats::count(&crate::stats::PLUGIN_SKIPS);
            return false;
        };
        let started = Instant::now();
        let processing = &mut *processing;
        {
            let mut list = processing.events.list.borrow_mut();
            list.clear();
            for (on, pitch, velocity) in slot.notes.drain(..) {
                let mut event: Event = std::mem::zeroed();
                if on {
                    event.r#type = Event_::EventTypes_::kNoteOnEvent as u16;
                    event.__field0.noteOn = NoteOnEvent { channel: 0, pitch, tuning: 0.0, velocity, length: 0, noteId: -1 };
                } else {
                    event.r#type = Event_::EventTypes_::kNoteOffEvent as u16;
                    event.__field0.noteOff = NoteOffEvent { channel: 0, pitch, velocity, noteId: -1, tuning: 0.0 };
                }
                list.push(event);
            }
        }
        {
            let params = &processing.params;
            let mut count = 0;
            for (id, normalized) in slot.changes.drain() {
                if count == MAX_PARAM_CHANGES { break; }
                params.queues[count].0.id.set(id);
                params.queues[count].0.value.set(normalized);
                count += 1;
            }
            params.count.set(count);
        }
        let playing = flags & FLAG_PLAYING != 0;
        let context = &mut processing.context;
        context.tempo = bpm as f64;
        context.projectTimeMusic = position / 960.0;
        context.state = ProcessContext_::StatesAndFlags_::kTempoValid | ProcessContext_::StatesAndFlags_::kProjectTimeMusicValid
            | if playing { ProcessContext_::StatesAndFlags_::kPlaying } else { 0 };
        let mut channels = [left, right];
        let mut output = AudioBusBuffers { numChannels: 2, silenceFlags: 0, __field0: std::mem::zeroed() };
        output.__field0.channelBuffers32 = channels.as_mut_ptr();
        let mut data = ProcessData {
            processMode: ProcessModes_::kRealtime as i32,
            symbolicSampleSize: SymbolicSampleSizes_::kSample32 as i32,
            numSamples: frames.min(MAX_BLOCK) as i32,
            numInputs: 0,
            numOutputs: processing.outputs,
            inputs: ptr::null_mut(),
            outputs: &mut output,
            inputParameterChanges: processing.param_list.as_ptr(),
            outputParameterChanges: ptr::null_mut(),
            inputEvents: processing.event_list.as_ptr(),
            outputEvents: ptr::null_mut(),
            processContext: &mut processing.context,
        };
        let wrote = processing.processor.process(&mut data) == kResultOk && processing.outputs > 0;
        crate::stats::record_max(&crate::stats::MAX_PLUGIN_US, started);
        wrote
    })
}

// ---------- plugin windows ----------

#[cfg(target_os = "macos")]
mod windows {
    use std::cell::{Cell, RefCell};
    use std::ffi::c_void;
    use std::io::Write;
    use std::ptr::NonNull;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::{define_class, msg_send, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSApplication, NSApplicationActivationOptions, NSBackingStoreType, NSEvent, NSEventMask,
                        NSEventModifierFlags, NSRunningApplication, NSWindow, NSWindowStyleMask, NSWorkspace};
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};

    pub const PLATFORM_TYPE: vst3::Steinberg::FIDString = vst3::Steinberg::kPlatformTypeNSView;
    // the key left of 1 (US) or left of Y (ISO), macOS cycles windows with it
    const CYCLE_KEY: u16 = 50;
    const FLOATING_LEVEL: isize = 3;
    const NORMAL_LEVEL: isize = 0;
    const LEVEL_TICKS: u32 = 20;

    thread_local! {
        static WINDOWS: RefCell<Vec<(u32, Retained<NSWindow>)>> = const { RefCell::new(Vec::new()) };
        static FLOATING: Cell<bool> = const { Cell::new(false) };
        static TICKS: Cell<u32> = const { Cell::new(0) };
        static MONITOR: Cell<bool> = const { Cell::new(false) };
    }

    fn mtm() -> MainThreadMarker {MainThreadMarker::new().expect("plugin windows live on the main thread")}

    // The window's own content view: keys the plugin's view leaves unhandled travel up the responder chain to it and
    // go on to the studio, so its shortcuts (Space, Cmd+S, ...) work while a plugin window is in front
    define_class!(
        #[unsafe(super(objc2_app_kit::NSView, objc2_app_kit::NSResponder, objc2_foundation::NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "OpenDAWPluginContentView"]
        struct ContentView;

        impl ContentView {
            #[unsafe(method(acceptsFirstResponder))]
            fn accepts_first_responder(&self) -> bool {true}

            #[unsafe(method(keyDown:))]
            fn key_down(&self, event: &NSEvent) {forward(event, "keydown")}

            #[unsafe(method(keyUp:))]
            fn key_up(&self, event: &NSEvent) {forward(event, "keyup")}

            #[unsafe(method(performKeyEquivalent:))]
            fn perform_key_equivalent(&self, event: &NSEvent) -> objc2::runtime::Bool {
                let handled: objc2::runtime::Bool = unsafe { msg_send![super(self), performKeyEquivalent: event] };
                if handled.as_bool() || !event.modifierFlags().contains(NSEventModifierFlags::Command) { return handled; }
                if event.keyCode() == CLOSE_KEY {
                    if let Some(window) = self.window() { window.performClose(None); }
                } else if event.keyCode() == QUIT_KEY {
                    request_shell("/__quit");
                } else {
                    forward(event, "keydown");
                }
                objc2::runtime::Bool::YES
            }
        }
    );

    const CLOSE_KEY: u16 = 13;
    const QUIT_KEY: u16 = 12;

    fn request_shell(path: &'static str) {
        std::thread::spawn(move || {
            if let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", 47110)) {
                let _ = stream.write_all(format!("GET {path} HTTP/1.0\r\n\r\n").as_bytes());
            }
        });
    }

    // macOS virtual key codes to the DOM `code` the studio's shortcuts match
    fn dom_code(key: u16) -> Option<&'static str> {
        const LETTERS: [(u16, &str); 26] = [(0, "KeyA"), (11, "KeyB"), (8, "KeyC"), (2, "KeyD"), (14, "KeyE"), (3, "KeyF"),
            (5, "KeyG"), (4, "KeyH"), (34, "KeyI"), (38, "KeyJ"), (40, "KeyK"), (37, "KeyL"), (46, "KeyM"), (45, "KeyN"),
            (31, "KeyO"), (35, "KeyP"), (12, "KeyQ"), (15, "KeyR"), (1, "KeyS"), (17, "KeyT"), (32, "KeyU"), (9, "KeyV"),
            (13, "KeyW"), (7, "KeyX"), (16, "KeyY"), (6, "KeyZ")];
        const OTHERS: [(u16, &str); 42] = [(29, "Digit0"), (18, "Digit1"), (19, "Digit2"), (20, "Digit3"), (21, "Digit4"),
            (23, "Digit5"), (22, "Digit6"), (26, "Digit7"), (28, "Digit8"), (25, "Digit9"), (49, "Space"), (36, "Enter"),
            (48, "Tab"), (51, "Backspace"), (117, "Delete"), (53, "Escape"), (123, "ArrowLeft"), (124, "ArrowRight"),
            (125, "ArrowDown"), (126, "ArrowUp"), (115, "Home"), (119, "End"), (116, "PageUp"), (121, "PageDown"),
            (27, "Minus"), (24, "Equal"), (33, "BracketLeft"), (30, "BracketRight"), (41, "Semicolon"), (39, "Quote"),
            (42, "Backslash"), (43, "Comma"), (47, "Period"), (44, "Slash"), (122, "F1"), (120, "F2"), (99, "F3"),
            (118, "F4"), (96, "F5"), (97, "F6"), (98, "F7"), (100, "F8")];
        LETTERS.iter().chain(OTHERS.iter()).find(|(code, _)| *code == key).map(|(_, name)| *name)
    }

    fn forward(event: &NSEvent, kind: &'static str) {
        let Some(code) = dom_code(event.keyCode()) else { return };
        let key = event.charactersIgnoringModifiers().map(|text| text.to_string()).unwrap_or_default();
        let flags = event.modifierFlags();
        let bit = |flag: NSEventModifierFlags| flags.contains(flag) as u8;
        let query = format!("type={kind}&code={code}&key={}&shift={}&ctrl={}&alt={}&meta={}&repeat={}",
            encode(&key), bit(NSEventModifierFlags::Shift), bit(NSEventModifierFlags::Control),
            bit(NSEventModifierFlags::Option), bit(NSEventModifierFlags::Command), (kind == "keydown" && event.isARepeat()) as u8);
        std::thread::spawn(move || {
            if let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", 47110)) {
                let _ = stream.write_all(format!("GET /__key?{query} HTTP/1.0\r\n\r\n").as_bytes());
            }
        });
    }

    fn encode(text: &str) -> String {
        text.bytes().map(|byte| if byte.is_ascii_alphanumeric() { (byte as char).to_string() } else { format!("%{byte:02X}") }).collect()
    }

    pub fn open(handle: u32, title: &str, width: f64, height: f64) -> *mut c_void {
        install_monitor();
        let window = unsafe {
            NSWindow::initWithContentRect_styleMask_backing_defer(
                mtm().alloc(), NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, height)),
                NSWindowStyleMask::Titled | NSWindowStyleMask::Closable | NSWindowStyleMask::Miniaturizable,
                NSBackingStoreType::Buffered, false)
        };
        unsafe { window.setReleasedWhenClosed(false); }
        window.setTitle(&NSString::from_str(title));
        window.setLevel(if FLOATING.get() { FLOATING_LEVEL } else { NORMAL_LEVEL });
        window.center();
        let content: Retained<ContentView> = unsafe {
            msg_send![ContentView::alloc(mtm()), initWithFrame: NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, height))]
        };
        window.setContentView(Some(&content));
        window.makeFirstResponder(Some(&content));
        let parent = Retained::as_ptr(&content) as *mut c_void;
        WINDOWS.with(|windows| windows.borrow_mut().push((handle, window.clone())));
        front_window(&window);
        parent
    }

    fn front_window(window: &NSWindow) {
        window.makeKeyAndOrderFront(None);
        #[allow(deprecated)]
        NSApplication::sharedApplication(mtm()).activateIgnoringOtherApps(true);
    }

    fn find(handle: u32) -> Option<Retained<NSWindow>> {
        WINDOWS.with(|windows| windows.borrow().iter().find(|(id, _)| *id == handle).map(|(_, window)| window.clone()))
    }

    pub fn resize(handle: u32, width: f64, height: f64) {
        if let Some(window) = find(handle) { window.setContentSize(NSSize::new(width, height)); }
    }

    pub fn front(handle: u32) {
        if let Some(window) = find(handle) { front_window(&window); }
    }

    pub fn close(handle: u32) {
        let removed = WINDOWS.with(|windows| {
            let mut windows = windows.borrow_mut();
            windows.iter().position(|(id, _)| *id == handle).map(|index| windows.remove(index).1)
        });
        let Some(window) = removed else { return };
        window.close();
        // the engine is an app of its own: with its last window gone, the studio's main window takes the focus back
        if WINDOWS.with(|windows| windows.borrow().is_empty()) && NSApplication::sharedApplication(mtm()).isActive() {
            cycle_home();
        }
    }

    // windows the user closed with the close button
    pub fn closed() -> Vec<u32> {
        WINDOWS.with(|windows| windows.borrow().iter().filter(|(_, window)| !window.isVisible() && !window.isMiniaturized())
            .map(|(handle, _)| *handle).collect())
    }

    // plugin windows float above the studio while openDAW (the studio or this engine) is the frontmost app
    pub fn tick() {
        let ticks = TICKS.get() + 1;
        TICKS.set(ticks);
        if ticks % LEVEL_TICKS != 0 || WINDOWS.with(|windows| windows.borrow().is_empty()) { return; }
        let frontmost = NSWorkspace::sharedWorkspace().frontmostApplication().map(|app| app.processIdentifier());
        let ours = frontmost.is_some_and(|pid| pid == std::process::id() as i32 || pid == std::os::unix::process::parent_id() as i32);
        if ours == FLOATING.get() { return; }
        FLOATING.set(ours);
        WINDOWS.with(|windows| windows.borrow().iter()
            .for_each(|(_, window)| window.setLevel(if ours { FLOATING_LEVEL } else { NORMAL_LEVEL })));
    }

    // the studio passed Cmd+` on after its last window
    pub fn cycle_in() {
        match WINDOWS.with(|windows| windows.borrow().first().map(|(_, window)| window.clone())) {
            Some(window) => front_window(&window),
            None => cycle_home(),
        }
    }

    // hands Cmd+` back to the studio, which fronts its first window
    fn cycle_home() {
        if let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", 47110)) {
            let _ = stream.write_all(b"GET /__cycle-home HTTP/1.0\r\n\r\n");
        }
        let shell = NSRunningApplication::runningApplicationWithProcessIdentifier(std::os::unix::process::parent_id() as i32);
        #[allow(deprecated)]
        if let Some(shell) = shell { shell.activateWithOptions(NSApplicationActivationOptions::ActivateIgnoringOtherApps); }
    }

    fn cycle_next() {
        let key = NSApplication::sharedApplication(mtm()).keyWindow();
        let next = WINDOWS.with(|windows| {
            let windows = windows.borrow();
            let index = key.and_then(|key| windows.iter().position(|(_, window)| **window == *key));
            index.and_then(|index| windows.get(index + 1)).map(|(_, window)| window.clone())
        });
        match next {
            Some(window) => front_window(&window),
            None => cycle_home(),
        }
    }

    fn install_monitor() {
        if MONITOR.replace(true) { return; }
        let handler = RcBlock::new(|event: NonNull<NSEvent>| -> *mut NSEvent {
            let event_ref = unsafe { event.as_ref() };
            let command = event_ref.modifierFlags().contains(NSEventModifierFlags::Command);
            if command && event_ref.keyCode() == CYCLE_KEY {
                cycle_next();
                return std::ptr::null_mut();
            }
            event.as_ptr()
        });
        let monitor = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &handler) };
        std::mem::forget(monitor);
    }
}

#[cfg(not(target_os = "macos"))]
mod windows {
    use std::ffi::c_void;

    pub const PLATFORM_TYPE: vst3::Steinberg::FIDString = b"none\0".as_ptr() as vst3::Steinberg::FIDString;

    pub fn open(_handle: u32, _title: &str, _width: f64, _height: f64) -> *mut c_void {std::ptr::null_mut()}
    pub fn resize(_handle: u32, _width: f64, _height: f64) {}
    pub fn front(_handle: u32) {}
    pub fn close(_handle: u32) {}
    pub fn closed() -> Vec<u32> {Vec::new()}
    pub fn tick() {}
    pub fn cycle_in() {}
}
