// WebKitGTK honours COOP/COEP only with these features on, an API (2.42+) beyond wry's bindings, so looked up at runtime
use std::ffi::{c_char, c_int, c_void, CStr};

use webkit2gtk::glib::translate::ToGlibPtr;
use webkit2gtk::WebViewExt;

const FEATURES: [&str; 2] = ["CrossOriginOpenerPolicy", "CrossOriginEmbedderPolicy"];

type AllFeatures = unsafe extern "C" fn() -> *mut c_void;
type Length = unsafe extern "C" fn(*mut c_void) -> usize;
type Get = unsafe extern "C" fn(*mut c_void, usize) -> *mut c_void;
type Identifier = unsafe extern "C" fn(*mut c_void) -> *const c_char;
type SetEnabled = unsafe extern "C" fn(*mut c_void, *mut c_void, c_int);
type Unref = unsafe extern "C" fn(*mut c_void);

extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

fn symbol<T: Copy>(name: &CStr) -> Option<T> {
    // a null handle is RTLD_DEFAULT, which searches the libraries already loaded
    let pointer = unsafe { dlsym(std::ptr::null_mut(), name.as_ptr()) };
    (!pointer.is_null()).then(|| unsafe { std::mem::transmute_copy(&pointer) })
}

fn enable(webview: &webkit2gtk::WebView) {
    let version = unsafe { (webkit2gtk::ffi::webkit_get_major_version(), webkit2gtk::ffi::webkit_get_minor_version()) };
    let (Some(all), Some(length), Some(get), Some(identifier), Some(set_enabled), Some(unref)) = (
        symbol::<AllFeatures>(c"webkit_settings_get_all_features"), symbol::<Length>(c"webkit_feature_list_get_length"),
        symbol::<Get>(c"webkit_feature_list_get"), symbol::<Identifier>(c"webkit_feature_get_identifier"),
        symbol::<SetEnabled>(c"webkit_settings_set_feature_enabled"), symbol::<Unref>(c"webkit_feature_list_unref"),
    ) else {
        eprintln!("[openDAW] WebKitGTK {}.{} cannot enable cross-origin isolation (needs 2.42)", version.0, version.1);
        return;
    };
    let Some(settings) = webview.settings() else { return };
    let settings: *mut webkit2gtk::ffi::WebKitSettings = settings.to_glib_none().0;
    let mut enabled = Vec::new();
    unsafe {
        let list = all();
        for index in 0..length(list) {
            let feature = get(list, index);
            let name = CStr::from_ptr(identifier(feature)).to_string_lossy().into_owned();
            if FEATURES.iter().any(|prefix| name.starts_with(prefix)) {
                set_enabled(settings.cast(), feature, 1);
                enabled.push(name);
            }
        }
        unref(list);
    }
    eprintln!("[openDAW] WebKitGTK {}.{} enabled features: {enabled:?}", version.0, version.1);
}

pub fn load(webview: &webkit2gtk::WebView, url: &str) {
    enable(webview);
    webview.load_uri(url);
}
