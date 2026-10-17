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
            Ok(tungstenite::Message::Text(text)) => studio_request(&text),
            Ok(tungstenite::Message::Close(_)) => break,
            Err(tungstenite::Error::Io(error)) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(_) => break,
            Ok(_) => {}
        }
    }
    println!("[plugins] studio disconnected");
}

#[derive(serde::Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum StudioRequest {
    Scan { folders: Vec<String>, force: bool },
    // a studio dialog is open, plugin windows must not cover it
    Dialogs { open: bool },
}

fn studio_request(text: &str) {
    match serde_json::from_str::<StudioRequest>(text) {
        // scanning loads plugins in their own processes and can take seconds, so it runs on a thread of its own
        Ok(StudioRequest::Scan { folders, force }) => {
            std::thread::spawn(move || {
                let catalogue = crate::scan::run(&folders, force);
                notify("", "plugins", serde_json::to_string(&catalogue).unwrap());
            });
        }
        Ok(StudioRequest::Dialogs { open }) => request_main(MainRequest::Run(Box::new(move || windows::dialogs(open)))),
        Err(error) => eprintln!("[plugins] {error}"),
    }
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

    unsafe fn createInstance(&self, cid: *mut TUID, iid: *mut TUID, obj: *mut *mut c_void) -> tresult {
        *obj = ptr::null_mut();
        let is_message = |tuid: *mut TUID| !tuid.is_null() && (*tuid).iter().zip(IMessage::IID.iter()).all(|(a, b)| *a as u8 == *b);
        if !is_message(cid) || !is_message(iid) { return kNotImplemented; }
        let attributes = ComWrapper::new(Attributes { values: RefCell::new(HashMap::new()) });
        let Some(list) = attributes.to_com_ptr::<IAttributeList>() else { return kNotImplemented };
        let message = ComWrapper::new(Message { id: RefCell::new(std::ffi::CString::default()), attributes: list });
        match message.to_com_ptr::<IMessage>() {
            Some(pointer) => {
                *obj = pointer.into_raw() as *mut c_void;
                kResultOk
            }
            None => kNotImplemented,
        }
    }
}

// what plugin windows send to their audio part through the connection points
struct Message {
    id: RefCell<std::ffi::CString>,
    attributes: ComPtr<IAttributeList>,
}

impl Class for Message {
    type Interfaces = (IMessage,);
}

impl IMessageTrait for Message {
    unsafe fn getMessageID(&self) -> FIDString {self.id.borrow().as_ptr()}

    unsafe fn setMessageID(&self, id: FIDString) {
        *self.id.borrow_mut() = if id.is_null() { std::ffi::CString::default() } else { std::ffi::CStr::from_ptr(id).to_owned() };
    }

    unsafe fn getAttributes(&self) -> *mut IAttributeList {self.attributes.as_ptr()}
}

enum Attribute {
    Int(int64),
    Float(f64),
    Text(Vec<TChar>),
    Binary(Vec<u8>),
}

struct Attributes {
    values: RefCell<HashMap<Vec<u8>, Attribute>>,
}

impl Attributes {
    unsafe fn key(id: IAttributeList_::AttrID) -> Option<Vec<u8>> {
        (!id.is_null()).then(|| std::ffi::CStr::from_ptr(id).to_bytes().to_vec())
    }

    unsafe fn set(&self, id: IAttributeList_::AttrID, value: Attribute) -> tresult {
        match Self::key(id) {
            Some(key) => {
                self.values.borrow_mut().insert(key, value);
                kResultOk
            }
            None => kInvalidArgument,
        }
    }
}

impl Class for Attributes {
    type Interfaces = (IAttributeList,);
}

impl IAttributeListTrait for Attributes {
    unsafe fn setInt(&self, id: IAttributeList_::AttrID, value: int64) -> tresult {self.set(id, Attribute::Int(value))}

    unsafe fn getInt(&self, id: IAttributeList_::AttrID, value: *mut int64) -> tresult {
        match Self::key(id).and_then(|key| match self.values.borrow().get(&key) { Some(Attribute::Int(found)) => Some(*found), _ => None }) {
            Some(found) => {
                *value = found;
                kResultOk
            }
            None => kResultFalse,
        }
    }

    unsafe fn setFloat(&self, id: IAttributeList_::AttrID, value: f64) -> tresult {self.set(id, Attribute::Float(value))}

    unsafe fn getFloat(&self, id: IAttributeList_::AttrID, value: *mut f64) -> tresult {
        match Self::key(id).and_then(|key| match self.values.borrow().get(&key) { Some(Attribute::Float(found)) => Some(*found), _ => None }) {
            Some(found) => {
                *value = found;
                kResultOk
            }
            None => kResultFalse,
        }
    }

    unsafe fn setString(&self, id: IAttributeList_::AttrID, string: *const TChar) -> tresult {
        if string.is_null() { return kInvalidArgument; }
        let length = (0..).take_while(|index| *string.add(*index) != 0).count();
        self.set(id, Attribute::Text(std::slice::from_raw_parts(string, length).to_vec()))
    }

    unsafe fn getString(&self, id: IAttributeList_::AttrID, string: *mut TChar, sizeInBytes: uint32) -> tresult {
        let Some(key) = Self::key(id) else { return kInvalidArgument };
        let values = self.values.borrow();
        let Some(Attribute::Text(text)) = values.get(&key) else { return kResultFalse };
        let capacity = sizeInBytes as usize / size_of::<TChar>();
        if string.is_null() || capacity == 0 { return kInvalidArgument; }
        let count = text.len().min(capacity - 1);
        ptr::copy_nonoverlapping(text.as_ptr(), string, count);
        *string.add(count) = 0;
        kResultOk
    }

    unsafe fn setBinary(&self, id: IAttributeList_::AttrID, data: *const c_void, sizeInBytes: uint32) -> tresult {
        let bytes = if data.is_null() { Vec::new() } else { std::slice::from_raw_parts(data as *const u8, sizeInBytes as usize).to_vec() };
        self.set(id, Attribute::Binary(bytes))
    }

    unsafe fn getBinary(&self, id: IAttributeList_::AttrID, data: *mut *const c_void, sizeInBytes: *mut uint32) -> tresult {
        let Some(key) = Self::key(id) else { return kInvalidArgument };
        match self.values.borrow().get(&key) {
            Some(Attribute::Binary(bytes)) => {
                *data = bytes.as_ptr() as *const c_void;
                *sizeInBytes = bytes.len() as uint32;
                kResultOk
            }
            _ => kResultFalse,
        }
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
        let mut list = self.list.borrow_mut();
        if list.len() == list.capacity() { return kResultFalse; }
        list.push(*event);
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
    // a copy for an offline render: nothing it does reaches the studio
    offline: bool,
}

impl Class for ComponentHandler {
    type Interfaces = (IComponentHandler, IComponentHandler2);
}

impl ComponentHandler {
    fn report(&self, id: ParamID, normalized: f64) {
        if self.offline { return; }
        let Some(max) = self.ranges.borrow().get(&id).copied() else { return };
        self.inbox.lock().unwrap().edits.push((id, normalized));
        notify(&self.uuid, "param", format!("{id}:{}", normalized * max));
    }

    unsafe fn reread(&self, titles: bool) {
        if self.offline { return; }
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
const MAX_OUTPUT_PARAMS: usize = 64;
const MAX_OUTPUT_POINTS: usize = 16;

// DPF plugins (Cardinal) assert without an output change list
struct OutputQueue {
    id: Cell<ParamID>,
    points: RefCell<Vec<(int32, ParamValue)>>,
}

impl Class for OutputQueue {
    type Interfaces = (IParamValueQueue,);
}

impl IParamValueQueueTrait for OutputQueue {
    unsafe fn getParameterId(&self) -> ParamID {self.id.get()}
    unsafe fn getPointCount(&self) -> int32 {self.points.borrow().len() as int32}

    unsafe fn getPoint(&self, index: int32, offset: *mut int32, value: *mut ParamValue) -> tresult {
        match self.points.borrow().get(index as usize) {
            Some((at, point)) => {
                *offset = *at;
                *value = *point;
                kResultOk
            }
            None => kInvalidArgument,
        }
    }

    unsafe fn addPoint(&self, offset: int32, value: ParamValue, index: *mut int32) -> tresult {
        let mut points = self.points.borrow_mut();
        if points.len() == MAX_OUTPUT_POINTS { return kResultFalse; }
        points.push((offset, value));
        if !index.is_null() { *index = points.len() as int32 - 1; }
        kResultOk
    }
}

struct OutputChanges {
    queues: Vec<(ComWrapper<OutputQueue>, ComPtr<IParamValueQueue>)>,
    count: Cell<usize>,
}

impl OutputChanges {
    fn clear(&self) {
        for (queue, _) in &self.queues[..self.count.get()] { queue.points.borrow_mut().clear(); }
        self.count.set(0);
    }
}

impl Class for OutputChanges {
    type Interfaces = (IParameterChanges,);
}

impl IParameterChangesTrait for OutputChanges {
    unsafe fn getParameterCount(&self) -> int32 {self.count.get() as int32}

    unsafe fn getParameterData(&self, index: int32) -> *mut IParamValueQueue {
        if index < 0 || index as usize >= self.count.get() { return ptr::null_mut(); }
        self.queues[index as usize].1.as_ptr()
    }

    unsafe fn addParameterData(&self, id: *const ParamID, index: *mut int32) -> *mut IParamValueQueue {
        if id.is_null() { return ptr::null_mut(); }
        let count = self.count.get();
        let slot = match self.queues[..count].iter().position(|(queue, _)| queue.id.get() == *id) {
            Some(slot) => slot,
            None if count < self.queues.len() => {
                self.queues[count].0.id.set(*id);
                self.count.set(count + 1);
                count
            }
            None => return ptr::null_mut(),
        };
        if !index.is_null() { *index = slot as int32; }
        self.queues[slot].1.as_ptr()
    }
}

fn output_changes() -> ComWrapper<OutputChanges> {
    let queues = (0..MAX_OUTPUT_PARAMS).map(|_| {
        let queue = ComWrapper::new(OutputQueue { id: Cell::new(0), points: RefCell::new(Vec::with_capacity(MAX_OUTPUT_POINTS)) });
        let pointer = queue.to_com_ptr::<IParamValueQueue>().unwrap();
        (queue, pointer)
    }).collect();
    ComWrapper::new(OutputChanges { queues, count: Cell::new(0) })
}

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

#[cfg(not(target_os = "linux"))]
impl Class for Frame {
    type Interfaces = (IPlugFrame,);
}

// Linux plugins ask the frame for the host's run loop to get their descriptors and timers served
#[cfg(target_os = "linux")]
impl Class for Frame {
    type Interfaces = (IPlugFrame, Linux::IRunLoop);
}

#[cfg(target_os = "linux")]
impl Linux::IRunLoopTrait for Frame {
    unsafe fn registerEventHandler(&self, handler: *mut Linux::IEventHandler, fd: Linux::FileDescriptor) -> tresult {
        match vst3::ComRef::from_raw(handler) {
            Some(handler) => {
                windows::register_event(handler.to_com_ptr(), fd);
                kResultOk
            }
            None => kInvalidArgument,
        }
    }

    unsafe fn unregisterEventHandler(&self, handler: *mut Linux::IEventHandler) -> tresult {
        windows::unregister_event(handler);
        kResultOk
    }

    unsafe fn registerTimer(&self, handler: *mut Linux::ITimerHandler, milliseconds: Linux::TimerInterval) -> tresult {
        match vst3::ComRef::from_raw(handler) {
            Some(handler) => {
                windows::register_timer(handler.to_com_ptr(), milliseconds);
                kResultOk
            }
            None => kInvalidArgument,
        }
    }

    unsafe fn unregisterTimer(&self, handler: *mut Linux::ITimerHandler) -> tresult {
        windows::unregister_timer(handler);
        kResultOk
    }
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
    output_events: ComWrapper<Events>,
    output_event_list: ComPtr<IEventList>,
    params: ComWrapper<ParamChanges>,
    param_list: ComPtr<IParameterChanges>,
    outputs_changes: ComWrapper<OutputChanges>,
    output_list: ComPtr<IParameterChanges>,
    context: ProcessContext,
    inputs: i32,
    outputs: i32,
    mode: i32,
    // the input of a plugin that takes audio but is played as an instrument
    silence: Vec<f32>,
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
    offline: bool,
}

thread_local! {
    static MODULES: RefCell<HashMap<PathBuf, Rc<Module>>> = RefCell::new(HashMap::new());
    static EDITORS: RefCell<HashMap<u32, Rc<Editor>>> = RefCell::new(HashMap::new());
    static DIRTY: RefCell<std::collections::HashSet<u32>> = RefCell::new(std::collections::HashSet::new());
}

fn editor(handle: u32) -> Option<Rc<Editor>> {EDITORS.with(|editors| editors.borrow().get(&handle).cloned())}

// the studio's instances, never the copies of an offline render
fn all_editors() -> Vec<(u32, Rc<Editor>)> {
    EDITORS.with(|editors| editors.borrow().iter().filter(|(_, editor)| !editor.offline).map(|(handle, editor)| (*handle, editor.clone())).collect())
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
unsafe fn instantiate(handle: u32, uuid: &str, format: &str, id: &str, sample_rate: f64, state: Option<Vec<u8>>, offline: bool) -> Option<Loaded> {
    if format != "vst3" { return None; }
    // an offline render plays what the studio's instance holds right now, saved or not
    let state = if offline {
        all_editors().into_iter().find(|(_, editor)| editor.uuid == uuid).map(|(_, editor)| read_state(&editor.component, &editor.controller))
            .or(state)
    } else { state };
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
        applying: Cell::new(false), offline
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
    if audio_ins > 0 { component.activateBus(MediaTypes_::kAudio as i32, BusDirections_::kInput as i32, 0, 1); }
    if audio_outs > 0 { component.activateBus(MediaTypes_::kAudio as i32, BusDirections_::kOutput as i32, 0, 1); }
    if event_ins > 0 { component.activateBus(MediaTypes_::kEvent as i32, BusDirections_::kInput as i32, 0, 1); }
    let mode = if offline { ProcessModes_::kOffline } else { ProcessModes_::kRealtime } as i32;
    let mut setup = ProcessSetup {
        processMode: mode,
        symbolicSampleSize: SymbolicSampleSizes_::kSample32 as i32,
        maxSamplesPerBlock: MAX_BLOCK as i32,
        sampleRate: sample_rate,
    };
    if !check("setupProcessing", processor.setupProcessing(&mut setup)) { return None; }
    check("setActive", component.setActive(1));
    // optional in VST3, many plugins answer kNotImplemented
    let processing = processor.setProcessing(1);
    if processing != kNotImplemented { check("setProcessing", processing); }
    let events = ComWrapper::new(Events { list: RefCell::new(Vec::with_capacity(64)) });
    let event_list = events.to_com_ptr::<IEventList>()?;
    let output_events = ComWrapper::new(Events { list: RefCell::new(Vec::with_capacity(64)) });
    let output_event_list = output_events.to_com_ptr::<IEventList>()?;
    let mut context: ProcessContext = std::mem::zeroed();
    context.sampleRate = sample_rate;
    context.timeSigNumerator = 4;
    context.timeSigDenominator = 4;
    let params = param_changes();
    let param_list = params.to_com_ptr::<IParameterChanges>()?;
    let outputs_changes = output_changes();
    let output_list = outputs_changes.to_com_ptr::<IParameterChanges>()?;
    let shared = Arc::new(Mutex::new(Processing {
        component: component.clone(), processor, events, event_list, output_events, output_event_list, params, param_list, outputs_changes, output_list, context,
        inputs: audio_ins.min(1), outputs: audio_outs.min(1), mode, silence: vec![0.0; MAX_BLOCK]
    }));
    let infos = read_params(&controller);
    let ranges: HashMap<ParamID, f64> = infos.iter().map(|param| (param.id, param.max)).collect();
    *handler.ranges.borrow_mut() = ranges.clone();
    if !offline { notify(uuid, "params", serde_json::to_string(&automatable(&infos)).unwrap()); }
    EDITORS.with(|editors| editors.borrow_mut().insert(handle, Rc::new(Editor {
        uuid: uuid.to_string(), name: info.name.clone(), component, controller, shared: shared.clone(), view: RefCell::new(None),
        reread_at: Cell::new(None), inbox: inbox.clone(), handler, offline
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

// Linux: the main thread waits here for X11, the plugins' descriptors and their timers
#[cfg(target_os = "linux")]
pub fn pump(wait: std::time::Duration) {windows::pump(wait)}

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
        // macOS scales by itself, Windows editors draw at the screen's scale once they know it
        #[cfg(target_os = "windows")]
        if let Some(scaling) = view.cast::<IPlugViewContentScaleSupport>() { scaling.setContentScaleFactor(windows::scale_factor()); }
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
    // the sample rate of an offline render, its copy loads on the first block once fields and state are known
    offline: Option<f64>,
    tried: bool,
    // blocks in a row the plugin left unwritten (an unlicensed plugin returns without processing)
    unwritten: u32,
    inactive: bool,
}

// every thread keeps its own slots (the engine thread, each offline render), the handles are unique process wide
thread_local! {
    static SLOTS: RefCell<HashMap<u32, Slot>> = RefCell::new(HashMap::new());
}

static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

const OFFLINE_LOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

pub fn create_slot(uuid: String) -> u32 {create_any_slot(uuid, None)}

pub fn create_offline_slot(uuid: String, sample_rate: f64) -> u32 {create_any_slot(uuid, Some(sample_rate))}

fn create_any_slot(uuid: String, offline: Option<f64>) -> u32 {
    let handle = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    SLOTS.with(|slots| slots.borrow_mut().insert(handle, Slot {
        uuid, generation: 0, format: String::new(), id: String::new(), shared: None, notes: Vec::new(),
        state: None, known_state: None, inbox: None, ranges: HashMap::new(), pending: HashMap::new(),
        changes: HashMap::new(), reported: HashMap::new(), modulation: HashMap::new(), edits: HashMap::new(),
        offline, tried: false, unwritten: 0, inactive: false
    }));
    handle
}

// the offline render's thread waits for its copy, the render must not start without the plugin
fn load_offline(handle: u32, slot: &mut Slot, sample_rate: f64) {
    slot.tried = true;
    if slot.format.is_empty() || slot.id.is_empty() { return; }
    let (uuid, format, id) = (slot.uuid.clone(), slot.format.clone(), slot.id.clone());
    let state = slot.state.clone().filter(|state| !state.is_empty());
    let (sender, receiver) = std::sync::mpsc::channel();
    request_main(MainRequest::Run(Box::new(move || {
        let _ = sender.send(unsafe { instantiate(handle, &uuid, &format, &id, sample_rate, state, true) });
    })));
    match receiver.recv_timeout(OFFLINE_LOAD_TIMEOUT) {
        Ok(Some(Loaded { shared, inbox, ranges })) => {
            slot.shared = Some(shared);
            slot.inbox = Some(inbox);
            slot.ranges = ranges;
            for (id, (kind, value, modulation)) in std::mem::take(&mut slot.pending) {
                queue_param(slot, id, kind, value, modulation);
            }
        }
        Ok(None) => eprintln!("[plugins] {} could not load for the offline render", slot.id),
        Err(_) => eprintln!("[plugins] {} did not load in time for the offline render", slot.id),
    }
}

// an offline render ends: its copies are released with it
pub fn release_thread_slots() {
    let handles: Vec<u32> = SLOTS.with(|slots| slots.borrow().keys().copied().collect());
    handles.into_iter().for_each(release);
}

pub fn load(handle: u32, format: String, id: String, sample_rate: f64) {
    SLOTS.with(|slots| {
        let mut slots = slots.borrow_mut();
        let Some(slot) = slots.get_mut(&handle) else { return };
        if slot.format == format && slot.id == id { return; }
        if slot.offline.is_some() {
            slot.format = format;
            slot.id = id;
            return;
        }
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
            let shared = unsafe { instantiate(handle, &uuid, &format, &id, sample_rate, state, false) };
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
        if slot.offline.is_some() {
            slot.state = Some(state);
            return;
        }
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
// a NaN no plugin writes: still in the output after a block, the plugin did not process it
const UNWRITTEN: u32 = 0x7FC0_DEAD;
const INACTIVE_AFTER: u32 = 16;

// marks the channels before a block
unsafe fn mark_unwritten(channels: &[*mut f32], frames: usize) {
    for channel in channels { std::slice::from_raw_parts_mut(*channel, frames).fill(f32::from_bits(UNWRITTEN)); }
}

// after a block: false when the plugin left the output unwritten; a marker left in a partly written channel becomes
// silence, so it never reaches the engine
unsafe fn take_written(channels: &[*mut f32], frames: usize, silent: bool) -> bool {
    let mut written = false;
    for channel in channels {
        let samples = std::slice::from_raw_parts_mut(*channel, frames);
        let mut untouched = 0;
        for sample in samples.iter_mut() {
            if sample.to_bits() == UNWRITTEN {
                *sample = 0.0;
                untouched += 1;
            }
        }
        written |= untouched < frames;
    }
    written || silent
}

fn track_unwritten(slot: &mut Slot, written: bool) {
    let inactive = if written {
        slot.unwritten = 0;
        false
    } else {
        slot.unwritten = slot.unwritten.saturating_add(1);
        slot.unwritten >= INACTIVE_AFTER
    };
    if inactive == slot.inactive || (!written && !inactive) { return; }
    slot.inactive = inactive;
    if slot.offline.is_none() { notify(&slot.uuid, "processing", if inactive { "inactive" } else { "active" }); }
}

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

// writes `frames` into the two channel pointers, an effect reads its input from `input`; false while the plugin is not
// ready (an instrument adds nothing, an effect passes its input through)
pub unsafe fn process(handle: u32, input: Option<(*mut f32, *mut f32)>, left: *mut f32, right: *mut f32, frames: usize, bpm: f32,
                      position: f64, flags: u32) -> bool {
    take_loaded();
    SLOTS.with(|slots| {
        let mut slots = slots.borrow_mut();
        let Some(slot) = slots.get_mut(&handle) else { return false };
        if let Some(sample_rate) = slot.offline.filter(|_| !slot.tried) { load_offline(handle, slot, sample_rate); }
        let Some(shared) = slot.shared.clone() else { return false };
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
        // an offline render waits instead of dropping a block
        let locked = if slot.offline.is_some() { shared.lock().map_err(|_| ()) } else { shared.try_lock().map_err(|_| ()) };
        let Ok(mut processing) = locked else {
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
        processing.outputs_changes.clear();
        processing.output_events.list.borrow_mut().clear();
        let playing = flags & FLAG_PLAYING != 0;
        let context = &mut processing.context;
        context.tempo = bpm as f64;
        context.projectTimeMusic = position / 960.0;
        // the flag constants are signed on Windows, unsigned elsewhere
        context.state = (ProcessContext_::StatesAndFlags_::kTempoValid | ProcessContext_::StatesAndFlags_::kProjectTimeMusicValid
            | if playing { ProcessContext_::StatesAndFlags_::kPlaying } else { 0 }) as _;
        let mut channels = [left, right];
        let mut output = AudioBusBuffers { numChannels: 2, silenceFlags: 0, __field0: std::mem::zeroed() };
        output.__field0.channelBuffers32 = channels.as_mut_ptr();
        let silence = processing.silence.as_mut_ptr();
        let mut input_channels = match input { Some((in_left, in_right)) => [in_left, in_right], None => [silence, silence] };
        let mut input_bus = AudioBusBuffers { numChannels: 2, silenceFlags: 0, __field0: std::mem::zeroed() };
        input_bus.__field0.channelBuffers32 = input_channels.as_mut_ptr();
        let frames = frames.min(MAX_BLOCK);
        mark_unwritten(&channels, frames);
        let mut data = ProcessData {
            processMode: processing.mode,
            symbolicSampleSize: SymbolicSampleSizes_::kSample32 as i32,
            numSamples: frames as i32,
            numInputs: processing.inputs,
            numOutputs: processing.outputs,
            inputs: if processing.inputs > 0 { &mut input_bus } else { ptr::null_mut() },
            outputs: &mut output,
            inputParameterChanges: processing.param_list.as_ptr(),
            outputParameterChanges: processing.output_list.as_ptr(),
            inputEvents: processing.event_list.as_ptr(),
            outputEvents: processing.output_event_list.as_ptr(),
            processContext: &mut processing.context,
        };
        let processed = processing.processor.process(&mut data) == kResultOk && processing.outputs > 0;
        let silent = output.silenceFlags & 0b11 == 0b11;
        let written = take_written(&channels, frames, silent);
        crate::stats::record_max(&crate::stats::MAX_PLUGIN_US, started);
        track_unwritten(slot, processed && written);
        processed && written
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
        static DIALOGS: Cell<bool> = const { Cell::new(false) };
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

    // plugin windows float above the studio while openDAW (the studio or this engine) is the frontmost app and no
    // studio dialog is open
    pub fn tick() {
        let ticks = TICKS.get() + 1;
        TICKS.set(ticks);
        if ticks % LEVEL_TICKS == 0 { apply_level(); }
    }

    fn apply_level() {
        if WINDOWS.with(|windows| windows.borrow().is_empty()) { return; }
        let frontmost = NSWorkspace::sharedWorkspace().frontmostApplication().map(|app| app.processIdentifier());
        let ours = frontmost.is_some_and(|pid| pid == std::process::id() as i32 || pid == std::os::unix::process::parent_id() as i32);
        let floating = ours && !DIALOGS.get();
        if floating == FLOATING.get() { return; }
        FLOATING.set(floating);
        WINDOWS.with(|windows| windows.borrow().iter()
            .for_each(|(_, window)| window.setLevel(if floating { FLOATING_LEVEL } else { NORMAL_LEVEL })));
    }

    // a dialog opened from a plugin window (a forwarded shortcut) also needs the studio in front
    pub fn dialogs(open: bool) {
        DIALOGS.set(open);
        apply_level();
        if open && NSApplication::sharedApplication(mtm()).isActive() { cycle_home(); }
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

// Windows: one native window per plugin editor on the engine's main thread, which runs a Windows message loop
#[cfg(target_os = "windows")]
mod windows {
    use std::cell::{Cell, RefCell};
    use std::ffi::c_void;
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::HiDpi::GetDpiForSystem;
    use windows_sys::Win32::UI::WindowsAndMessaging::{AdjustWindowRectEx, CreateWindowExW, DefWindowProcW, DestroyWindow,
                                                     GetForegroundWindow, GetWindowThreadProcessId, LoadCursorW, RegisterClassW,
                                                     SetForegroundWindow, SetWindowPos, ShowWindow, CW_USEDEFAULT, HWND_NOTOPMOST,
                                                     HWND_TOPMOST, IDC_ARROW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
                                                     SW_RESTORE, SW_SHOW, WM_CLOSE, WNDCLASSW, WS_CAPTION, WS_MINIMIZEBOX,
                                                     WS_OVERLAPPED, WS_SYSMENU};

    pub const PLATFORM_TYPE: vst3::Steinberg::FIDString = vst3::Steinberg::kPlatformTypeHWND;
    const STYLE: u32 = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
    const LEVEL_TICKS: u32 = 20;

    thread_local! {
        static WINDOWS: RefCell<Vec<(u32, HWND)>> = const { RefCell::new(Vec::new()) };
        static CLOSED: RefCell<Vec<u32>> = const { RefCell::new(Vec::new()) };
        static REGISTERED: Cell<bool> = const { Cell::new(false) };
        static TOPMOST: Cell<bool> = const { Cell::new(false) };
        static DIALOGS: Cell<bool> = const { Cell::new(false) };
        static TICKS: Cell<u32> = const { Cell::new(0) };
    }

    fn wide(text: &str) -> Vec<u16> {text.encode_utf16().chain(std::iter::once(0)).collect()}

    fn class_name() -> Vec<u16> {wide("OpenDAWPluginWindow")}

    // the studio's process, passed by the shell: plugin windows stay above it
    fn shell_process() -> u32 {
        static SHELL: OnceLock<u32> = OnceLock::new();
        *SHELL.get_or_init(|| std::env::var("OPENDAW_SHELL_PID").ok().and_then(|pid| pid.parse().ok()).unwrap_or(0))
    }

    // the close button only marks the window: the host detaches the plugin view first, then close() destroys it
    unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if message == WM_CLOSE {
            if let Some(handle) = WINDOWS.with(|windows| windows.borrow().iter().find(|(_, window)| *window == hwnd).map(|(handle, _)| *handle)) {
                CLOSED.with(|closed| closed.borrow_mut().push(handle));
            }
            return 0;
        }
        DefWindowProcW(hwnd, message, wparam, lparam)
    }

    fn register() {
        if REGISTERED.replace(true) { return; }
        let name = class_name();
        let class = WNDCLASSW {
            style: 0, lpfnWndProc: Some(window_proc), cbClsExtra: 0, cbWndExtra: 0,
            hInstance: unsafe { GetModuleHandleW(std::ptr::null()) }, hIcon: std::ptr::null_mut(),
            hCursor: unsafe { LoadCursorW(std::ptr::null_mut(), IDC_ARROW) }, hbrBackground: std::ptr::null_mut(),
            lpszMenuName: std::ptr::null(), lpszClassName: name.as_ptr()
        };
        unsafe { RegisterClassW(&class); }
    }

    fn outer_size(width: f64, height: f64) -> (i32, i32) {
        let mut rect = RECT { left: 0, top: 0, right: width as i32, bottom: height as i32 };
        unsafe { AdjustWindowRectEx(&mut rect, STYLE, 0, 0); }
        (rect.right - rect.left, rect.bottom - rect.top)
    }

    fn find(handle: u32) -> Option<HWND> {
        WINDOWS.with(|windows| windows.borrow().iter().find(|(other, _)| *other == handle).map(|(_, window)| *window))
    }

    // the plugin's size is in pixels, the engine runs DPI aware
    pub fn scale_factor() -> f32 {unsafe { GetDpiForSystem() as f32 / 96.0 }}

    pub fn open(handle: u32, title: &str, width: f64, height: f64) -> *mut c_void {
        register();
        let (outer_width, outer_height) = outer_size(width, height);
        let (name, title) = (class_name(), wide(title));
        let hwnd = unsafe {
            CreateWindowExW(0, name.as_ptr(), title.as_ptr(), STYLE, CW_USEDEFAULT, CW_USEDEFAULT, outer_width, outer_height,
                            std::ptr::null_mut(), std::ptr::null_mut(), GetModuleHandleW(std::ptr::null()), std::ptr::null())
        };
        if hwnd.is_null() { return std::ptr::null_mut(); }
        WINDOWS.with(|windows| windows.borrow_mut().push((handle, hwnd)));
        unsafe {
            ShowWindow(hwnd, SW_SHOW);
            SetForegroundWindow(hwnd);
        }
        TOPMOST.set(false);
        apply_level();
        hwnd
    }

    pub fn resize(handle: u32, width: f64, height: f64) {
        let Some(hwnd) = find(handle) else { return };
        let (outer_width, outer_height) = outer_size(width, height);
        unsafe { SetWindowPos(hwnd, std::ptr::null_mut(), 0, 0, outer_width, outer_height, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE); }
    }

    pub fn front(handle: u32) {
        let Some(hwnd) = find(handle) else { return };
        unsafe {
            ShowWindow(hwnd, SW_RESTORE);
            SetForegroundWindow(hwnd);
        }
    }

    pub fn close(handle: u32) {
        let hwnd = WINDOWS.with(|windows| {
            let mut windows = windows.borrow_mut();
            let index = windows.iter().position(|(other, _)| *other == handle)?;
            Some(windows.remove(index).1)
        });
        if let Some(hwnd) = hwnd { unsafe { DestroyWindow(hwnd); } }
    }

    pub fn closed() -> Vec<u32> {CLOSED.with(|closed| std::mem::take(&mut *closed.borrow_mut()))}

    // plugin windows stay above the studio while openDAW (the studio or this engine) is in front and no studio dialog is open
    pub fn tick() {
        let ticks = TICKS.get() + 1;
        TICKS.set(ticks);
        if ticks % LEVEL_TICKS == 0 { apply_level(); }
    }

    fn apply_level() {
        if WINDOWS.with(|windows| windows.borrow().is_empty()) { return; }
        let mut process = 0u32;
        unsafe { GetWindowThreadProcessId(GetForegroundWindow(), &mut process); }
        let ours = process != 0 && (process == std::process::id() || process == shell_process());
        let topmost = ours && !DIALOGS.get();
        if topmost == TOPMOST.get() { return; }
        TOPMOST.set(topmost);
        let level = if topmost { HWND_TOPMOST } else { HWND_NOTOPMOST };
        WINDOWS.with(|windows| windows.borrow().iter().for_each(|(_, hwnd)| unsafe {
            SetWindowPos(*hwnd, level, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }));
    }

    pub fn dialogs(open: bool) {
        DIALOGS.set(open);
        apply_level();
    }

    pub fn cycle_in() {
        if let Some((handle, _)) = WINDOWS.with(|windows| windows.borrow().first().copied()) { front(handle); }
    }
}

// Linux: one X11 window per plugin editor (libX11 opened at runtime), and the run loop Linux plugins need: they register
// their file descriptors and timers with the host, the engine's main thread polls them next to the X11 connection
#[cfg(target_os = "linux")]
mod windows {
    use std::cell::{Cell, RefCell};
    use std::ffi::{c_void, CString};
    use std::time::{Duration, Instant};
    use vst3::ComPtr;
    use vst3::Steinberg::Linux::{FileDescriptor, IEventHandler, IEventHandlerTrait, ITimerHandler, ITimerHandlerTrait, TimerInterval};
    use x11_dl::xlib;

    pub const PLATFORM_TYPE: vst3::Steinberg::FIDString = vst3::Steinberg::kPlatformTypeX11EmbedWindowID;

    struct X11 {
        lib: xlib::Xlib,
        display: *mut xlib::Display,
        delete: xlib::Atom,
    }

    struct Timer {
        handler: ComPtr<ITimerHandler>,
        interval: Duration,
        next: Instant,
    }

    thread_local! {
        static X: RefCell<Option<X11>> = const { RefCell::new(None) };
        static TRIED: Cell<bool> = const { Cell::new(false) };
        static WINDOWS: RefCell<Vec<(u32, xlib::Window)>> = const { RefCell::new(Vec::new()) };
        static CLOSED: RefCell<Vec<u32>> = const { RefCell::new(Vec::new()) };
        static HANDLERS: RefCell<Vec<(ComPtr<IEventHandler>, FileDescriptor)>> = const { RefCell::new(Vec::new()) };
        static TIMERS: RefCell<Vec<Timer>> = const { RefCell::new(Vec::new()) };
    }

    // without an X server (Wayland without XWayland) there are no editors
    fn with_x<R>(work: impl FnOnce(&X11) -> R) -> Option<R> {
        if !TRIED.replace(true) {
            let opened = xlib::Xlib::open().ok().and_then(|lib| {
                let display = unsafe { (lib.XOpenDisplay)(std::ptr::null()) };
                if display.is_null() { return None; }
                let name = CString::new("WM_DELETE_WINDOW").unwrap();
                let delete = unsafe { (lib.XInternAtom)(display, name.as_ptr(), 0) };
                Some(X11 { lib, display, delete })
            });
            if opened.is_none() { eprintln!("[plugins] no X11 display, plugin windows are unavailable"); }
            X.with(|x| *x.borrow_mut() = opened);
        }
        X.with(|x| x.borrow().as_ref().map(work))
    }

    fn find(handle: u32) -> Option<xlib::Window> {
        WINDOWS.with(|windows| windows.borrow().iter().find(|(other, _)| *other == handle).map(|(_, window)| *window))
    }

    // the editor sets the size, the user does not
    fn fix_size(x: &X11, window: xlib::Window, width: i32, height: i32) {
        unsafe {
            let hints = (x.lib.XAllocSizeHints)();
            if hints.is_null() { return; }
            (*hints).flags = xlib::PMinSize | xlib::PMaxSize;
            (*hints).min_width = width;
            (*hints).max_width = width;
            (*hints).min_height = height;
            (*hints).max_height = height;
            (x.lib.XSetWMNormalHints)(x.display, window, hints);
            (x.lib.XFree)(hints as *mut c_void);
        }
    }

    pub fn open(handle: u32, title: &str, width: f64, height: f64) -> *mut c_void {
        let window = with_x(|x| unsafe {
            let screen = (x.lib.XDefaultScreen)(x.display);
            let root = (x.lib.XRootWindow)(x.display, screen);
            let window = (x.lib.XCreateSimpleWindow)(x.display, root, 0, 0, width.max(1.0) as u32, height.max(1.0) as u32, 0, 0, 0);
            let name = CString::new(title.replace('\0', "")).unwrap_or_default();
            (x.lib.XStoreName)(x.display, window, name.as_ptr());
            let mut delete = x.delete;
            (x.lib.XSetWMProtocols)(x.display, window, &mut delete, 1);
            fix_size(x, window, width as i32, height as i32);
            (x.lib.XMapRaised)(x.display, window);
            (x.lib.XFlush)(x.display);
            window
        });
        match window {
            Some(window) => {
                WINDOWS.with(|windows| windows.borrow_mut().push((handle, window)));
                window as *mut c_void
            }
            None => std::ptr::null_mut(),
        }
    }

    pub fn resize(handle: u32, width: f64, height: f64) {
        let Some(window) = find(handle) else { return };
        with_x(|x| unsafe {
            fix_size(x, window, width as i32, height as i32);
            (x.lib.XResizeWindow)(x.display, window, width.max(1.0) as u32, height.max(1.0) as u32);
            (x.lib.XFlush)(x.display);
        });
    }

    pub fn front(handle: u32) {
        let Some(window) = find(handle) else { return };
        with_x(|x| unsafe {
            (x.lib.XMapRaised)(x.display, window);
            (x.lib.XFlush)(x.display);
        });
    }

    pub fn close(handle: u32) {
        let window = WINDOWS.with(|windows| {
            let mut windows = windows.borrow_mut();
            let index = windows.iter().position(|(other, _)| *other == handle)?;
            Some(windows.remove(index).1)
        });
        let Some(window) = window else { return };
        with_x(|x| unsafe {
            (x.lib.XDestroyWindow)(x.display, window);
            (x.lib.XFlush)(x.display);
        });
    }

    pub fn closed() -> Vec<u32> {CLOSED.with(|closed| std::mem::take(&mut *closed.borrow_mut()))}

    pub fn tick() {}
    pub fn dialogs(_open: bool) {}

    pub fn cycle_in() {
        if let Some((handle, _)) = WINDOWS.with(|windows| windows.borrow().first().copied()) { front(handle); }
    }

    // the window manager's close button arrives as a message, the host detaches the view before close() destroys it
    fn read_events() {
        with_x(|x| unsafe {
            while (x.lib.XPending)(x.display) > 0 {
                let mut event: xlib::XEvent = std::mem::zeroed();
                (x.lib.XNextEvent)(x.display, &mut event);
                if event.get_type() != xlib::ClientMessage { continue; }
                let message = event.client_message;
                if message.data.get_long(0) as xlib::Atom != x.delete { continue; }
                let handle = WINDOWS.with(|windows| windows.borrow().iter().find(|(_, window)| *window == message.window).map(|(handle, _)| *handle));
                if let Some(handle) = handle { CLOSED.with(|closed| closed.borrow_mut().push(handle)); }
            }
        });
    }

    pub fn register_event(handler: ComPtr<IEventHandler>, fd: FileDescriptor) {HANDLERS.with(|handlers| handlers.borrow_mut().push((handler, fd)));}

    pub fn unregister_event(handler: *mut IEventHandler) {
        HANDLERS.with(|handlers| handlers.borrow_mut().retain(|(other, _)| other.as_ptr() != handler));
    }

    pub fn register_timer(handler: ComPtr<ITimerHandler>, milliseconds: TimerInterval) {
        let interval = Duration::from_millis(milliseconds.max(1));
        TIMERS.with(|timers| timers.borrow_mut().push(Timer { handler, interval, next: Instant::now() + interval }));
    }

    pub fn unregister_timer(handler: *mut ITimerHandler) {
        TIMERS.with(|timers| timers.borrow_mut().retain(|timer| timer.handler.as_ptr() != handler));
    }

    // waits up to `wait` for the X11 connection or a plugin's descriptor, then serves both and the due timers
    pub fn pump(wait: Duration) {
        let x11 = with_x(|x| unsafe { (x.lib.XConnectionNumber)(x.display) });
        let handlers: Vec<(ComPtr<IEventHandler>, FileDescriptor)> = HANDLERS.with(|handlers| handlers.borrow().clone());
        let next_timer = TIMERS.with(|timers| timers.borrow().iter().map(|timer| timer.next).min());
        let wait = next_timer.map_or(wait, |next| wait.min(next.saturating_duration_since(Instant::now())));
        let mut fds: Vec<libc::pollfd> = x11.into_iter().chain(handlers.iter().map(|(_, fd)| *fd))
            .map(|fd| libc::pollfd { fd, events: libc::POLLIN, revents: 0 }).collect();
        unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, wait.as_millis() as i32); }
        read_events();
        let offset = if x11.is_some() { 1 } else { 0 };
        for (index, (handler, fd)) in handlers.iter().enumerate() {
            if fds[index + offset].revents != 0 { unsafe { handler.onFDIsSet(*fd); } }
        }
        let now = Instant::now();
        let due: Vec<ComPtr<ITimerHandler>> = TIMERS.with(|timers| timers.borrow_mut().iter_mut()
            .filter(|timer| timer.next <= now)
            .map(|timer| {
                timer.next = now + timer.interval;
                timer.handler.clone()
            }).collect());
        due.iter().for_each(|handler| unsafe { handler.onTimer(); });
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
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
    pub fn dialogs(_open: bool) {}
}
