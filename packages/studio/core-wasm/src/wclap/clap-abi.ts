// CLAP struct offsets on wasm32 (ILP32): 4-byte pointers, 8-byte aligned doubles and i64
export namespace ClapAbi {
    export const VERSION = {major: 1, minor: 2, revision: 2}
    export const INVALID_ID = 0xFFFFFFFF

    export namespace PluginEntry {
        export const INIT = 12
        export const DEINIT = 16
        export const GET_FACTORY = 20
    }

    export namespace PluginFactory {
        export const ID = "clap.plugin-factory"
        export const GET_PLUGIN_COUNT = 0
        export const GET_PLUGIN_DESCRIPTOR = 4
        export const CREATE_PLUGIN = 8
    }

    export namespace PluginDescriptor {
        export const ID = 12
        export const NAME = 16
        export const VENDOR = 20
        export const VERSION = 36
        export const FEATURES = 44
    }

    export namespace Host {
        export const SIZE = 48
        export const HOST_DATA = 12
        export const NAME = 16
        export const VENDOR = 20
        export const URL = 24
        export const VERSION = 28
        export const GET_EXTENSION = 32
        export const REQUEST_RESTART = 36
        export const REQUEST_PROCESS = 40
        export const REQUEST_CALLBACK = 44
    }

    export namespace Plugin {
        export const INIT = 8
        export const DESTROY = 12
        export const ACTIVATE = 16
        export const DEACTIVATE = 20
        export const START_PROCESSING = 24
        export const STOP_PROCESSING = 28
        export const RESET = 32
        export const PROCESS = 36
        export const GET_EXTENSION = 40
        export const ON_MAIN_THREAD = 44
    }

    export namespace Process {
        export const SIZE = 40
        export const STEADY_TIME = 0
        export const FRAMES_COUNT = 8
        export const TRANSPORT = 12
        export const AUDIO_INPUTS = 16
        export const AUDIO_OUTPUTS = 20
        export const AUDIO_INPUTS_COUNT = 24
        export const AUDIO_OUTPUTS_COUNT = 28
        export const IN_EVENTS = 32
        export const OUT_EVENTS = 36
    }

    export namespace AudioBuffer {
        export const SIZE = 24
        export const DATA32 = 0
        export const DATA64 = 4
        export const CHANNEL_COUNT = 8
        export const LATENCY = 12
        export const CONSTANT_MASK = 16
    }

    export namespace InputEvents {
        export const SIZE = 12
        export const CTX = 0
        export const SIZE_FN = 4
        export const GET_FN = 8
    }

    export namespace OutputEvents {
        export const SIZE = 8
        export const CTX = 0
        export const TRY_PUSH_FN = 4
    }

    export namespace EventHeader {
        export const SIZE = 16
        export const TIME = 4
        export const SPACE_ID = 8
        export const TYPE = 10
        export const FLAGS = 12
    }

    export namespace EventType {
        export const NOTE_ON = 0
        export const NOTE_OFF = 1
        export const NOTE_CHOKE = 2
        export const PARAM_VALUE = 5
        export const PARAM_MOD = 6
        export const PARAM_GESTURE_BEGIN = 7
        export const PARAM_GESTURE_END = 8
        export const TRANSPORT = 9
    }

    export namespace NoteEvent {
        export const SIZE = 40
        export const NOTE_ID = 16
        export const PORT_INDEX = 20
        export const CHANNEL = 22
        export const KEY = 24
        export const VELOCITY = 32
    }

    export namespace ParamValueEvent {
        export const SIZE = 48
        export const PARAM_ID = 16
        export const COOKIE = 20
        export const NOTE_ID = 24
        export const PORT_INDEX = 28
        export const CHANNEL = 30
        export const KEY = 32
        export const VALUE = 40
    }

    export namespace Ext {
        export const GUI = "clap.gui"
        export const AUDIO_PORTS = "clap.audio-ports"
        export const PARAMS = "clap.params"
        export const STATE = "clap.state"
        export const WEBVIEW = "clap.webview/3"
        export const LOG = "clap.log"
        export const THREAD_CHECK = "clap.thread-check"
        export const PARAM_HOVERED = "clap.param-hovered/1"
        export const HOST_PARAMS = "clap.params"
    }

    export namespace AudioPorts {
        export const COUNT = 0
        export const GET = 4
    }

    export namespace Params {
        export const COUNT = 0
        export const GET_INFO = 4
        export const GET_VALUE = 8
        export const VALUE_TO_TEXT = 12
        export const TEXT_TO_VALUE = 16
        export const FLUSH = 20
    }

    export namespace ParamFlags {
        export const IS_STEPPED = 1 << 0
        export const IS_HIDDEN = 1 << 2
        export const IS_READONLY = 1 << 3
        export const IS_AUTOMATABLE = 1 << 5
        export const IS_MODULATABLE = 1 << 10
        export const IS_ENUM = 1 << 16
    }

    export namespace ParamInfo {
        export const SIZE = 1320
        export const ID = 0
        export const FLAGS = 4
        export const NAME = 12
        export const MODULE = 268
        export const MIN_VALUE = 1296
        export const MAX_VALUE = 1304
        export const DEFAULT_VALUE = 1312
    }

    export namespace Gui {
        export const WINDOW_API_WEBVIEW = "webview"
        export const IS_API_SUPPORTED = 0
        export const CREATE = 8
        export const DESTROY = 12
        export const GET_SIZE = 20
        export const CAN_RESIZE = 24
        export const GET_RESIZE_HINTS = 28
        export const ADJUST_SIZE = 32
        export const SET_SIZE = 36
        export const SET_PARENT = 40
        export const SHOW = 52
        export const HIDE = 56
    }

    // clap_gui_resize_hints: three bools, then the aspect ratio as two u32
    export namespace ResizeHints {
        export const SIZE = 12
        export const PRESERVE_ASPECT_RATIO = 2
        export const ASPECT_RATIO_WIDTH = 4
        export const ASPECT_RATIO_HEIGHT = 8
    }

    // clap_window: api string pointer, then the native handle (NULL for a webview)
    export namespace Window {
        export const SIZE = 8
        export const API = 0
        export const PTR = 4
    }

    export namespace State {
        export const SAVE = 0
        export const LOAD = 4
    }

    export namespace HostState {
        export const SIZE = 4
        export const MARK_DIRTY = 0
    }

    // clap_istream / clap_ostream: ctx, then read/write(stream, buffer, u64 size) -> i64
    export namespace Stream {
        export const SIZE = 8
        export const CTX = 0
        export const FN = 4
    }

    export namespace Webview {
        export const GET_URI = 0
        export const GET_RESOURCE = 4
        export const RECEIVE = 8
    }

    export namespace HostWebview {
        export const SIZE = 4
        export const SEND = 0
    }

    export namespace HostLog {
        export const SIZE = 4
        export const LOG = 0
    }

    export namespace HostParams {
        export const SIZE = 12
        export const RESCAN = 0
        export const CLEAR = 4
        export const REQUEST_FLUSH = 8
    }

    // clap_event_transport, i64/f64 fields 8-aligned after the 16-byte header + flags
    export namespace TransportEvent {
        export const SIZE = 104
        export const FLAGS = 16
        export const SONG_POS_BEATS = 24
        export const SONG_POS_SECONDS = 32
        export const TEMPO = 40
        export const TEMPO_INC = 48
        export const LOOP_START_BEATS = 56
        export const LOOP_END_BEATS = 64
        export const LOOP_START_SECONDS = 72
        export const LOOP_END_SECONDS = 80
        export const BAR_START = 88
        export const BAR_NUMBER = 96
        export const TSIG_NUM = 100
        export const TSIG_DENOM = 102
        export const HAS_TEMPO = 1 << 0
        export const HAS_BEATS_TIMELINE = 1 << 1
        export const IS_PLAYING = 1 << 4
        export const BEATTIME_FACTOR = 2 ** 31
    }

    export namespace HostParamHovered {
        export const SIZE = 4
        export const UPDATE = 0
    }

    export namespace HostThreadCheck {
        export const SIZE = 8
        export const IS_MAIN_THREAD = 0
        export const IS_AUDIO_THREAD = 4
    }
}
