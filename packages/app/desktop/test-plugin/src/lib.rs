// openDAW Test Synth: a minimal VST3 instrument for the engine's tests and for pinning down host bugs by hand.
// Behaviours a real plugin showed are switched on with OPENDAW_TEST_PLUGIN (comma separated, read by the process
// that loads it, the engine inherits it from the shell):
//   aux      a second stereo output bus, active by default (Microtonic)
//   crash    aborts the process on the first audio block (crash marker)
//   silent   returns from process without writing its output (an unlicensed plugin)
//   linked   a host change of "Tone" makes the plugin edit "Follow" itself: beginEdit, performEdit, endEdit
//   titles   a host change of "Mode" renames the parameters: restartComponent(kParamTitlesChanged)
// Its window is one slider for "Tone" (macOS), dragging it edits like a knob in a plugin's own window: beginEdit,
// performEdit while dragging, endEdit on release. On Windows opening the window sweeps "Tone" from 0 to 1 in 1.5 seconds
// as one such gesture.
// Build and bundle with bundle.sh (--install puts it into the user's VST3 folder).
#![allow(non_snake_case)]

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::ffi::{c_char, c_void, CString};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::{ptr, slice};

use vst3::{uid, Class, ComPtr, ComRef, ComWrapper, Steinberg::Vst::*, Steinberg::*};

const NAME: &str = "openDAW Test Synth";
const VENDOR: &str = "openDAW";
const PARAMS: [&str; 4] = ["Level", "Tone", "Follow", "Mode"];
const LEVEL: u32 = 0;
const TONE: u32 = 1;
const FOLLOW: u32 = 2;
const MODE: u32 = 3;

// read on every call, so a test can switch behaviours between instances
fn switched(name: &str) -> bool {
    std::env::var("OPENDAW_TEST_PLUGIN").unwrap_or_default().split(',').any(|entry| entry.trim() == name)
}

fn copy_cstring(src: &str, dst: &mut [c_char]) {
    let text = CString::new(src).unwrap_or_default();
    for (index, byte) in text.as_bytes_with_nul().iter().take(dst.len()).enumerate() { dst[index] = *byte as c_char; }
    if let Some(last) = dst.last_mut() { *last = 0; }
}

fn copy_wstring(src: &str, dst: &mut [TChar]) {
    let mut length = 0;
    for (unit, slot) in src.encode_utf16().zip(dst.iter_mut()) {
        *slot = unit as TChar;
        length += 1;
    }
    if length < dst.len() { dst[length] = 0 } else if let Some(last) = dst.last_mut() { *last = 0 }
}

// the parameter values, also the state: four f64 in little endian
const DEFAULTS: [f64; 4] = [0.8, 0.5, 0.5, 0.0];

unsafe fn write_values(stream: *mut IBStream, values: [f64; 4]) -> tresult {
    let Some(stream) = ComRef::from_raw(stream) else { return kInvalidArgument };
    let bytes: Vec<u8> = values.iter().flat_map(|value| value.to_le_bytes()).collect();
    let mut written = 0;
    stream.write(bytes.as_ptr() as *mut c_void, bytes.len() as i32, &mut written);
    if written as usize == bytes.len() { kResultOk } else { kResultFalse }
}

unsafe fn read_values(stream: *mut IBStream) -> Option<[f64; 4]> {
    let stream = ComRef::from_raw(stream)?;
    let mut bytes = [0u8; 32];
    let mut read = 0;
    stream.read(bytes.as_mut_ptr() as *mut c_void, bytes.len() as i32, &mut read);
    if read != 32 { return None; }
    let mut values = [0.0; 4];
    for (index, value) in values.iter_mut().enumerate() {
        *value = f64::from_le_bytes(bytes[index * 8..index * 8 + 8].try_into().ok()?);
    }
    Some(values)
}

struct Processor {
    values: Mutex<[f64; 4]>,
    sample_rate: AtomicU64,
    phase: Cell<f64>,
    pitch: Cell<Option<i16>>,
    first_block: AtomicBool,
}

impl Class for Processor {
    type Interfaces = (IComponent, IAudioProcessor);
}

impl Processor {
    const CID: TUID = uid(0x6F70656E, 0x44415754, 0x65737453, 0x796E7468);

    fn aux_buses() -> i32 {if switched("aux") { 2 } else { 1 }}
}

impl IPluginBaseTrait for Processor {
    unsafe fn initialize(&self, _context: *mut FUnknown) -> tresult {kResultOk}
    unsafe fn terminate(&self) -> tresult {kResultOk}
}

impl IComponentTrait for Processor {
    unsafe fn getControllerClassId(&self, class_id: *mut TUID) -> tresult {
        *class_id = Controller::CID;
        kResultOk
    }

    unsafe fn setIoMode(&self, _mode: IoMode) -> tresult {kResultOk}

    unsafe fn getBusCount(&self, media_type: MediaType, direction: BusDirection) -> i32 {
        match (media_type as MediaTypes, direction as BusDirections) {
            (MediaTypes_::kAudio, BusDirections_::kOutput) => Self::aux_buses(),
            (MediaTypes_::kEvent, BusDirections_::kInput) => 1,
            _ => 0,
        }
    }

    unsafe fn getBusInfo(&self, media_type: MediaType, direction: BusDirection, index: i32, bus: *mut BusInfo) -> tresult {
        let bus = &mut *bus;
        match (media_type as MediaTypes, direction as BusDirections) {
            (MediaTypes_::kAudio, BusDirections_::kOutput) if index < Self::aux_buses() => {
                bus.mediaType = media_type;
                bus.direction = direction;
                bus.channelCount = 2;
                copy_wstring(if index == 0 { "Main" } else { "Aux" }, &mut bus.name);
                bus.busType = if index == 0 { BusTypes_::kMain } else { BusTypes_::kAux } as BusType;
                bus.flags = BusInfo_::BusFlags_::kDefaultActive as u32;
                kResultOk
            }
            (MediaTypes_::kEvent, BusDirections_::kInput) if index == 0 => {
                bus.mediaType = media_type;
                bus.direction = direction;
                bus.channelCount = 16;
                copy_wstring("Notes", &mut bus.name);
                bus.busType = BusTypes_::kMain as BusType;
                bus.flags = BusInfo_::BusFlags_::kDefaultActive as u32;
                kResultOk
            }
            _ => kInvalidArgument,
        }
    }

    unsafe fn getRoutingInfo(&self, _in_info: *mut RoutingInfo, _out_info: *mut RoutingInfo) -> tresult {kNotImplemented}
    unsafe fn activateBus(&self, _media_type: MediaType, _direction: BusDirection, _index: i32, _state: TBool) -> tresult {kResultOk}
    unsafe fn setActive(&self, _state: TBool) -> tresult {kResultOk}

    unsafe fn setState(&self, state: *mut IBStream) -> tresult {
        match read_values(state) {
            Some(values) => {
                *self.values.lock().unwrap() = values;
                kResultOk
            }
            None => kResultFalse,
        }
    }

    unsafe fn getState(&self, state: *mut IBStream) -> tresult {write_values(state, *self.values.lock().unwrap())}
}

impl IAudioProcessorTrait for Processor {
    unsafe fn setBusArrangements(&self, _inputs: *mut SpeakerArrangement, num_ins: i32, outputs: *mut SpeakerArrangement, num_outs: i32) -> tresult {
        if num_ins != 0 || num_outs != Self::aux_buses() { return kResultFalse; }
        if slice::from_raw_parts(outputs, num_outs as usize).iter().all(|arrangement| *arrangement == SpeakerArr::kStereo) { kResultTrue } else { kResultFalse }
    }

    unsafe fn getBusArrangement(&self, direction: BusDirection, index: i32, arrangement: *mut SpeakerArrangement) -> tresult {
        if direction as BusDirections == BusDirections_::kOutput && index < Self::aux_buses() {
            *arrangement = SpeakerArr::kStereo;
            kResultOk
        } else {
            kInvalidArgument
        }
    }

    unsafe fn canProcessSampleSize(&self, size: i32) -> tresult {
        if size as SymbolicSampleSizes == SymbolicSampleSizes_::kSample32 { kResultOk } else { kNotImplemented }
    }

    unsafe fn getLatencySamples(&self) -> u32 {0}

    unsafe fn setupProcessing(&self, setup: *mut ProcessSetup) -> tresult {
        self.sample_rate.store((*setup).sampleRate.to_bits(), Ordering::Relaxed);
        kResultOk
    }

    unsafe fn setProcessing(&self, _state: TBool) -> tresult {kResultOk}

    unsafe fn process(&self, data: *mut ProcessData) -> tresult {
        if switched("crash") && self.first_block.swap(false, Ordering::SeqCst) { std::process::abort(); }
        let data = &*data;
        if let Some(changes) = ComRef::from_raw(data.inputParameterChanges) {
            let mut values = self.values.lock().unwrap();
            for index in 0..changes.getParameterCount() {
                let Some(queue) = ComRef::from_raw(changes.getParameterData(index)) else { continue };
                let (mut offset, mut value) = (0, 0.0);
                if queue.getPoint(queue.getPointCount() - 1, &mut offset, &mut value) == kResultOk {
                    if let Some(slot) = values.get_mut(queue.getParameterId() as usize) { *slot = value; }
                }
            }
        }
        if let Some(events) = ComRef::from_raw(data.inputEvents) {
            for index in 0..events.getEventCount() {
                let mut event: Event = std::mem::zeroed();
                if events.getEvent(index, &mut event) != kResultOk { continue; }
                // the constants are signed on Windows, unsigned elsewhere
                let kind = event.r#type as i64;
                if kind == Event_::EventTypes_::kNoteOnEvent as i64 {
                    self.pitch.set(Some(event.__field0.noteOn.pitch));
                } else if kind == Event_::EventTypes_::kNoteOffEvent as i64 && self.pitch.get() == Some(event.__field0.noteOff.pitch) {
                    self.pitch.set(None);
                }
            }
        }
        if switched("silent") || data.numOutputs == 0 { return kResultOk; }
        let frames = data.numSamples as usize;
        let level = self.values.lock().unwrap()[LEVEL as usize] as f32 * 0.2;
        let rate = f64::from_bits(self.sample_rate.load(Ordering::Relaxed)).max(1.0);
        // with "aux" it writes every bus it declares, whatever the host passes, like Microtonic
        let count = if switched("aux") { Self::aux_buses() } else { data.numOutputs };
        let buses = slice::from_raw_parts(data.outputs, count as usize);
        let mut samples = vec![0.0f32; frames];
        if let Some(pitch) = self.pitch.get() {
            let step = 440.0 * 2f64.powf((pitch as f64 - 69.0) / 12.0) / rate;
            for sample in samples.iter_mut() {
                *sample = (self.phase.get() * std::f64::consts::TAU).sin() as f32 * level;
                self.phase.set((self.phase.get() + step).fract());
            }
        }
        for bus in buses {
            let channels = slice::from_raw_parts(bus.__field0.channelBuffers32, bus.numChannels as usize);
            for channel in channels {
                slice::from_raw_parts_mut(*channel, frames).copy_from_slice(&samples);
            }
        }
        kResultOk
    }

    unsafe fn getTailSamples(&self) -> u32 {0}
}

struct Controller {
    values: Rc<Cell<[f64; 4]>>,
    handler: RefCell<Option<ComPtr<IComponentHandler>>>,
}

impl Class for Controller {
    type Interfaces = (IEditController,);
}

impl Controller {
    const CID: TUID = uid(0x6F70656E, 0x44415754, 0x65737443, 0x74726C72);

    fn title(&self, id: u32) -> String {
        let mode = (self.values.get()[MODE as usize] * 3.0).round() as u32;
        if switched("titles") && mode > 0 { format!("{} {mode}", PARAMS[id as usize]) } else { PARAMS[id as usize].to_string() }
    }

    fn handler(&self) -> Option<ComPtr<IComponentHandler>> {self.handler.borrow().clone()}
}

impl IPluginBaseTrait for Controller {
    unsafe fn initialize(&self, _context: *mut FUnknown) -> tresult {kResultOk}
    unsafe fn terminate(&self) -> tresult {
        self.handler.replace(None);
        kResultOk
    }
}

impl IEditControllerTrait for Controller {
    unsafe fn setComponentState(&self, state: *mut IBStream) -> tresult {
        match read_values(state) {
            Some(values) => {
                self.values.set(values);
                kResultOk
            }
            None => kResultFalse,
        }
    }

    unsafe fn setState(&self, _state: *mut IBStream) -> tresult {kResultOk}
    unsafe fn getState(&self, _state: *mut IBStream) -> tresult {kResultOk}
    unsafe fn getParameterCount(&self) -> i32 {PARAMS.len() as i32}

    unsafe fn getParameterInfo(&self, index: i32, info: *mut ParameterInfo) -> tresult {
        if index < 0 || index as usize >= PARAMS.len() { return kInvalidArgument; }
        let info = &mut *info;
        info.id = index as u32;
        copy_wstring(&self.title(index as u32), &mut info.title);
        copy_wstring(&self.title(index as u32), &mut info.shortTitle);
        copy_wstring("", &mut info.units);
        info.stepCount = if index as u32 == MODE { 3 } else { 0 };
        info.defaultNormalizedValue = 0.5;
        info.unitId = 0;
        info.flags = ParameterInfo_::ParameterFlags_::kCanAutomate as i32;
        kResultOk
    }

    unsafe fn getParamStringByValue(&self, _id: u32, value: f64, string: *mut String128) -> tresult {
        copy_wstring(&format!("{value:.3}"), &mut *string);
        kResultOk
    }

    unsafe fn getParamValueByString(&self, _id: u32, _string: *mut TChar, _value: *mut f64) -> tresult {kNotImplemented}
    unsafe fn normalizedParamToPlain(&self, _id: u32, value: f64) -> f64 {value}
    unsafe fn plainParamToNormalized(&self, _id: u32, value: f64) -> f64 {value}

    unsafe fn getParamNormalized(&self, id: u32) -> f64 {self.values.get().get(id as usize).copied().unwrap_or(0.0)}

    // the host calls this on its main thread, where a plugin may talk back to it
    unsafe fn setParamNormalized(&self, id: u32, value: f64) -> tresult {
        let mut values = self.values.get();
        let Some(slot) = values.get_mut(id as usize) else { return kInvalidArgument };
        let changed = (*slot - value).abs() > 1e-9;
        *slot = value;
        self.values.set(values);
        if !changed { return kResultOk; }
        #[cfg(target_os = "macos")]
        if id == TONE { slider::refresh(); }
        if id == TONE && switched("linked") {
            if let Some(handler) = self.handler() {
                let mut values = self.values.get();
                values[FOLLOW as usize] = value;
                self.values.set(values);
                handler.beginEdit(FOLLOW);
                handler.performEdit(FOLLOW, value);
                handler.endEdit(FOLLOW);
            }
        }
        if id == MODE && switched("titles") {
            if let Some(handler) = self.handler() { handler.restartComponent(RestartFlags_::kParamTitlesChanged as i32); }
        }
        kResultOk
    }

    unsafe fn setComponentHandler(&self, handler: *mut IComponentHandler) -> tresult {
        self.handler.replace(ComRef::from_raw(handler).map(|handler| handler.to_com_ptr()));
        kResultOk
    }

    unsafe fn createView(&self, _name: *const c_char) -> *mut IPlugView {
        if !sweep::SUPPORTED { return ptr::null_mut(); }
        ComWrapper::new(View {values: self.values.clone(), handler: self.handler(), #[cfg(target_os = "macos")] slider: RefCell::new(None)})
            .to_com_ptr::<IPlugView>().map_or(ptr::null_mut(), |view| view.into_raw())
    }
}

// an empty window, opening it starts the sweep
struct View {
    values: Rc<Cell<[f64; 4]>>,
    handler: Option<ComPtr<IComponentHandler>>,
    #[cfg(target_os = "macos")]
    slider: RefCell<Option<objc2::rc::Retained<slider::Slider>>>,
}

impl Class for View {
    type Interfaces = (IPlugView,);
}

impl IPlugViewTrait for View {
    unsafe fn isPlatformTypeSupported(&self, platform: FIDString) -> tresult {
        if std::ffi::CStr::from_ptr(platform).to_bytes() == sweep::PLATFORM { kResultOk } else { kResultFalse }
    }

    unsafe fn attached(&self, _parent: *mut c_void, _platform: FIDString) -> tresult {
        let Some(handler) = self.handler.clone() else { return kResultOk };
        #[cfg(target_os = "macos")]
        self.slider.replace(Some(slider::attach(_parent, handler, self.values.clone())));
        #[cfg(not(target_os = "macos"))]
        sweep::start(handler, self.values.clone());
        kResultOk
    }

    unsafe fn removed(&self) -> tresult {
        #[cfg(target_os = "macos")]
        if let Some(slider) = self.slider.take() { slider::detach(&slider); }
        kResultOk
    }
    unsafe fn onWheel(&self, _distance: f32) -> tresult {kResultFalse}
    unsafe fn onKeyDown(&self, _key: char16, _code: int16, _modifiers: int16) -> tresult {kResultFalse}
    unsafe fn onKeyUp(&self, _key: char16, _code: int16, _modifiers: int16) -> tresult {kResultFalse}

    unsafe fn getSize(&self, size: *mut ViewRect) -> tresult {
        *size = ViewRect {left: 0, top: 0, right: 320, bottom: 120};
        kResultOk
    }

    unsafe fn onSize(&self, _size: *mut ViewRect) -> tresult {kResultOk}
    unsafe fn onFocus(&self, _state: TBool) -> tresult {kResultOk}
    unsafe fn setFrame(&self, _frame: *mut IPlugFrame) -> tresult {kResultOk}
    unsafe fn canResize(&self) -> tresult {kResultFalse}
    unsafe fn checkSizeConstraint(&self, _rect: *mut ViewRect) -> tresult {kResultOk}
}

#[cfg(target_os = "macos")]
mod slider {
    use super::*;
    use objc2::rc::Retained;
    use objc2::{define_class, msg_send, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSColor, NSEvent, NSRectFill, NSView};
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    struct Target {
        handler: ComPtr<IComponentHandler>,
        values: Rc<Cell<[f64; 4]>>,
    }

    thread_local! {
        static TARGET: RefCell<Option<Target>> = const { RefCell::new(None) };
        static SHOWN: RefCell<Option<Retained<Slider>>> = const { RefCell::new(None) };
    }

    // a value set by the host (undo, automation) is shown too
    pub fn refresh() {SHOWN.with(|shown| if let Some(slider) = shown.borrow().as_ref() { slider.setNeedsDisplay(true); })}

    define_class!(
        #[unsafe(super(NSView, objc2_app_kit::NSResponder, objc2_foundation::NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "OpenDAWTestSynthSlider"]
        pub struct Slider;

        impl Slider {
            #[unsafe(method(acceptsFirstMouse:))]
            fn accepts_first_mouse(&self, _event: Option<&NSEvent>) -> bool {true}

            #[unsafe(method(mouseDown:))]
            fn mouse_down(&self, event: &NSEvent) {
                TARGET.with(|target| if let Some(target) = target.borrow().as_ref() { unsafe { target.handler.beginEdit(TONE); } });
                self.drag(event);
            }

            #[unsafe(method(mouseDragged:))]
            fn mouse_dragged(&self, event: &NSEvent) {self.drag(event)}

            #[unsafe(method(mouseUp:))]
            fn mouse_up(&self, event: &NSEvent) {
                self.drag(event);
                TARGET.with(|target| if let Some(target) = target.borrow().as_ref() { unsafe { target.handler.endEdit(TONE); } });
            }

            #[unsafe(method(drawRect:))]
            fn draw_rect(&self, _dirty: NSRect) {
                let bounds = self.bounds();
                let value = TARGET.with(|target| target.borrow().as_ref().map_or(0.0, |target| target.values.get()[TONE as usize]));
                NSColor::colorWithCalibratedWhite_alpha(0.15, 1.0).setFill();
                NSRectFill(bounds);
                NSColor::colorWithCalibratedRed_green_blue_alpha(0.3, 0.7, 1.0, 1.0).setFill();
                NSRectFill(NSRect::new(bounds.origin, NSSize::new(bounds.size.width * value, bounds.size.height)));
            }
        }
    );

    impl Slider {
        fn drag(&self, event: &NSEvent) {
            let point = self.convertPoint_fromView(event.locationInWindow(), None);
            let value = (point.x / self.bounds().size.width.max(1.0)).clamp(0.0, 1.0);
            TARGET.with(|target| if let Some(target) = target.borrow().as_ref() {
                let mut values = target.values.get();
                values[TONE as usize] = value;
                target.values.set(values);
                unsafe { target.handler.performEdit(TONE, value); }
            });
            self.setNeedsDisplay(true);
        }
    }

    pub unsafe fn attach(parent: *mut c_void, handler: ComPtr<IComponentHandler>, values: Rc<Cell<[f64; 4]>>) -> Retained<Slider> {
        let mtm = MainThreadMarker::new().expect("main thread");
        TARGET.with(|target| *target.borrow_mut() = Some(Target {handler, values}));
        let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(320.0, 120.0));
        let slider: Retained<Slider> = msg_send![Slider::alloc(mtm), initWithFrame: frame];
        (*(parent as *const NSView)).addSubview(&slider);
        SHOWN.with(|shown| *shown.borrow_mut() = Some(slider.clone()));
        slider
    }

    pub fn detach(slider: &Slider) {
        slider.removeFromSuperview();
        SHOWN.with(|shown| *shown.borrow_mut() = None);
        TARGET.with(|target| *target.borrow_mut() = None);
    }
}

// the sweep runs on the host's main thread, from a timer of the platform's own loop
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
mod sweep {
    use super::*;

    const STEPS: u32 = 50;
    const INTERVAL_MS: u32 = 30;

    struct Sweep {
        handler: ComPtr<IComponentHandler>,
        values: Rc<Cell<[f64; 4]>>,
        step: u32,
    }

    thread_local! {
        static SWEEP: RefCell<Option<Sweep>> = const { RefCell::new(None) };
    }

    pub unsafe fn start(handler: ComPtr<IComponentHandler>, values: Rc<Cell<[f64; 4]>>) {
        if SWEEP.with(|sweep| sweep.borrow().is_some()) { return; }
        handler.beginEdit(TONE);
        SWEEP.with(|sweep| *sweep.borrow_mut() = Some(Sweep {handler, values, step: 0}));
        schedule();
    }

    // false once the sweep has ended
    fn tick() -> bool {
        let Some(mut sweep) = SWEEP.with(|sweep| sweep.borrow_mut().take()) else { return false };
        sweep.step += 1;
        let value = sweep.step as f64 / STEPS as f64;
        let mut values = sweep.values.get();
        values[TONE as usize] = value;
        sweep.values.set(values);
        unsafe { sweep.handler.performEdit(TONE, value); }
        if sweep.step >= STEPS {
            unsafe { sweep.handler.endEdit(TONE); }
            return false;
        }
        SWEEP.with(|slot| *slot.borrow_mut() = Some(sweep));
        true
    }

    #[cfg(target_os = "macos")]
    pub const SUPPORTED: bool = true;
    #[cfg(target_os = "macos")]
    pub const PLATFORM: &[u8] = b"NSView";

    #[cfg(target_os = "macos")]
    fn schedule() {}

    #[cfg(target_os = "windows")]
    pub const SUPPORTED: bool = true;
    #[cfg(target_os = "windows")]
    pub const PLATFORM: &[u8] = b"HWND";

    #[cfg(target_os = "windows")]
    fn schedule() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{KillTimer, SetTimer};
        unsafe extern "system" fn fire(_window: windows_sys::Win32::Foundation::HWND, _message: u32, id: usize, _time: u32) {
            if !tick() { KillTimer(ptr::null_mut(), id); }
        }
        unsafe { SetTimer(ptr::null_mut(), 0, INTERVAL_MS, Some(fire)); }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    pub const SUPPORTED: bool = false;
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    pub const PLATFORM: &[u8] = b"";

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    fn schedule() {}
}

struct Factory;

impl Class for Factory {
    type Interfaces = (IPluginFactory, IPluginFactory2);
}

impl IPluginFactoryTrait for Factory {
    unsafe fn getFactoryInfo(&self, info: *mut PFactoryInfo) -> tresult {
        let info = &mut *info;
        copy_cstring(VENDOR, &mut info.vendor);
        copy_cstring("https://opendaw.studio", &mut info.url);
        copy_cstring("", &mut info.email);
        info.flags = PFactoryInfo_::FactoryFlags_::kUnicode as int32;
        kResultOk
    }

    unsafe fn countClasses(&self) -> i32 {2}

    unsafe fn getClassInfo(&self, index: i32, info: *mut PClassInfo) -> tresult {
        let info = &mut *info;
        let (cid, category) = match index {
            0 => (Processor::CID, "Audio Module Class"),
            1 => (Controller::CID, "Component Controller Class"),
            _ => return kInvalidArgument,
        };
        info.cid = cid;
        info.cardinality = PClassInfo_::ClassCardinality_::kManyInstances as int32;
        copy_cstring(category, &mut info.category);
        copy_cstring(NAME, &mut info.name);
        kResultOk
    }

    unsafe fn createInstance(&self, cid: FIDString, iid: FIDString, object: *mut *mut c_void) -> tresult {
        let instance = match *(cid as *const TUID) {
            Processor::CID => ComWrapper::new(Processor {
                values: Mutex::new(DEFAULTS), sample_rate: AtomicU64::new(48_000f64.to_bits()), phase: Cell::new(0.0), pitch: Cell::new(None),
                first_block: AtomicBool::new(true)
            }).to_com_ptr::<FUnknown>(),
            Controller::CID => ComWrapper::new(Controller {
                values: Rc::new(Cell::new(DEFAULTS)), handler: RefCell::new(None)
            }).to_com_ptr::<FUnknown>(),
            _ => None,
        };
        match instance {
            Some(instance) => {
                let pointer = instance.as_ptr();
                ((*(*pointer).vtbl).queryInterface)(pointer, iid as *mut TUID, object)
            }
            None => kInvalidArgument,
        }
    }
}

impl IPluginFactory2Trait for Factory {
    unsafe fn getClassInfo2(&self, index: i32, info: *mut PClassInfo2) -> tresult {
        let info = &mut *info;
        let (cid, category, sub) = match index {
            0 => (Processor::CID, "Audio Module Class", "Instrument|Synth"),
            1 => (Controller::CID, "Component Controller Class", ""),
            _ => return kInvalidArgument,
        };
        info.cid = cid;
        info.cardinality = PClassInfo_::ClassCardinality_::kManyInstances as int32;
        copy_cstring(category, &mut info.category);
        copy_cstring(NAME, &mut info.name);
        info.classFlags = 0;
        copy_cstring(sub, &mut info.subCategories);
        copy_cstring(VENDOR, &mut info.vendor);
        copy_cstring("0.0.1", &mut info.version);
        copy_cstring("VST 3.7", &mut info.sdkVersion);
        kResultOk
    }
}

#[cfg(target_os = "windows")]
#[no_mangle]
extern "system" fn InitDll() -> bool {true}

#[cfg(target_os = "windows")]
#[no_mangle]
extern "system" fn ExitDll() -> bool {true}

#[cfg(target_os = "macos")]
#[no_mangle]
extern "C" fn bundleEntry(_bundle: *mut c_void) -> bool {true}

#[cfg(target_os = "macos")]
#[no_mangle]
extern "C" fn bundleExit() -> bool {true}

#[cfg(target_os = "linux")]
#[no_mangle]
extern "C" fn ModuleEntry(_library: *mut c_void) -> bool {true}

#[cfg(target_os = "linux")]
#[no_mangle]
extern "C" fn ModuleExit() -> bool {true}

#[no_mangle]
extern "system" fn GetPluginFactory() -> *mut IPluginFactory {
    ComWrapper::new(Factory).to_com_ptr::<IPluginFactory>().map_or(ptr::null_mut(), |factory| factory.into_raw())
}
