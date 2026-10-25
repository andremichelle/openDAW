// Test copy of opendaw-commons/wclaps/device-panel-demo/source/panel.c (CC0). Built twice with emcc:
// emcc device-panel.c -O2 -I<clap>/include -o device-panel.wasm -sSTANDALONE_WASM=1 --no-entry
//      -sEXPORTED_FUNCTIONS=_malloc,_free -Wl,--export=clap_entry -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=4MB
//      -sSTACK_SIZE=256KB -sALLOW_TABLE_GROWTH=1 -sERROR_ON_UNDEFINED_SYMBOLS=1
// and with -DOMIT_PANEL_EXTENSION into device-panel-no-extension.wasm: the feature listed, the extension missing.
// Page messages: 1 poll (answered with a 16 byte status), 5 request_show, 6 request_hide, 7 param-hovered.

#include <clap/clap.h>
#include <clap/ext/draft/webview.h>
#include <clap/ext/draft/param-hovered.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define VOICES 16
#define PARAM_GAIN 0
#define ATTACK_SECONDS 0.005
#define RELEASE_SECONDS 0.25
#define OUT_EVENTS 64
#define GUI_WIDTH 480
#define GUI_HEIGHT 320
#define GUI_MIN_WIDTH 240
#define GUI_MIN_HEIGHT 160
#define PANEL_WIDTH 176

// message types, see page/index.html
#define PAGE_POLL 1
#define PAGE_PARAM_BEGIN 2
#define PAGE_PARAM_SET 3
#define PAGE_PARAM_END 4
#define PAGE_OPEN_WINDOW 5
#define PAGE_CLOSE_WINDOW 6
#define PAGE_HOVER 7
#define PLUGIN_STATUS 1

#define OPENDAW_PLUGIN_FEATURE_DEVICE_PANEL "opendaw:device-panel"
#define OPENDAW_EXT_DEVICE_PANEL "opendaw.device-panel/1"

typedef struct opendaw_plugin_device_panel {
    int32_t (*get_uri)(const clap_plugin_t *plugin, char *uri, uint32_t capacity);
    bool (*get_width)(const clap_plugin_t *plugin, uint32_t height, uint32_t *width);
} opendaw_plugin_device_panel_t;

void emscripten_notify_memory_growth(size_t index) {(void) index;}

typedef struct {
    int active;
    int key;
    int channel;
    int released;
    double phase;
    double increment;
    double level;
    double velocity;
} Voice;

typedef struct {
    uint16_t type;
    clap_id id;
    double value;
} OutEvent;

typedef struct {
    clap_plugin_t plugin;
    const clap_host_t *host;
    const clap_host_params_t *host_params;
    const clap_host_webview_t *host_webview;
    const clap_host_gui_t *host_gui;
    const clap_host_param_hovered_t *host_hovered;
    double sample_rate;
    double gain;
    uint32_t active_voices;
    uint32_t gui_width, gui_height;
    OutEvent out_events[OUT_EVENTS];
    uint32_t out_read, out_write;
    Voice voices[VOICES];
} Sine;

static const char *features[] = {
    CLAP_PLUGIN_FEATURE_INSTRUMENT, CLAP_PLUGIN_FEATURE_SYNTHESIZER, CLAP_PLUGIN_FEATURE_STEREO,
    OPENDAW_PLUGIN_FEATURE_DEVICE_PANEL, NULL
};

static const clap_plugin_descriptor_t descriptor = {
    .clap_version = CLAP_VERSION_INIT,
    .id = "studio.opendaw.commons.device-panel-demo",
    .name = "Device Panel Demo",
    .vendor = "openDAW Commons",
    .url = "https://github.com/andremichelle/opendaw-commons/tree/main/wclaps/device-panel-demo",
    .manual_url = "",
    .support_url = "",
    .version = "1.0.0",
    .description = "A polyphonic sine synth with a device panel view",
    .features = features
};

static void push_out_event(Sine *sine, uint16_t type, clap_id id, double value) {
    if (sine->out_write - sine->out_read >= OUT_EVENTS) {return;}
    sine->out_events[sine->out_write % OUT_EVENTS] = (OutEvent) {type, id, value};
    sine->out_write++;
}

static void drain_out_events(Sine *sine, const clap_output_events_t *out) {
    while (sine->out_read != sine->out_write) {
        const OutEvent *event = &sine->out_events[sine->out_read % OUT_EVENTS];
        if (event->type == CLAP_EVENT_PARAM_VALUE) {
            const clap_event_param_value_t value = {
                .header = {sizeof(value), 0, CLAP_CORE_EVENT_SPACE_ID, CLAP_EVENT_PARAM_VALUE, 0},
                .param_id = event->id, .cookie = NULL, .note_id = -1, .port_index = -1, .channel = -1, .key = -1,
                .value = event->value
            };
            out->try_push(out, &value.header);
        } else {
            const clap_event_param_gesture_t gesture = {
                .header = {sizeof(gesture), 0, CLAP_CORE_EVENT_SPACE_ID, event->type, 0}, .param_id = event->id
            };
            out->try_push(out, &gesture.header);
        }
        sine->out_read++;
    }
}

static void note_on(Sine *sine, int key, int channel, double velocity) {
    Voice *target = NULL;
    for (int i = 0; i < VOICES && target == NULL; i++) {if (!sine->voices[i].active) {target = &sine->voices[i];}}
    if (target == NULL) {target = &sine->voices[0];}
    target->active = 1;
    target->key = key;
    target->channel = channel;
    target->released = 0;
    target->phase = 0.0;
    target->level = 0.0;
    target->velocity = velocity;
    target->increment = 440.0 * pow(2.0, (key - 69) / 12.0) / sine->sample_rate;
}

static void note_off(Sine *sine, int key, int channel) {
    for (int i = 0; i < VOICES; i++) {
        Voice *voice = &sine->voices[i];
        if (voice->active && voice->key == key && (channel < 0 || voice->channel == channel)) {voice->released = 1;}
    }
}

static void handle_event(Sine *sine, const clap_event_header_t *header) {
    if (header->space_id != CLAP_CORE_EVENT_SPACE_ID) {return;}
    switch (header->type) {
        case CLAP_EVENT_NOTE_ON: {
            const clap_event_note_t *note = (const clap_event_note_t *) header;
            note_on(sine, note->key, note->channel, note->velocity);
            break;
        }
        case CLAP_EVENT_NOTE_OFF: {
            const clap_event_note_t *note = (const clap_event_note_t *) header;
            note_off(sine, note->key, note->channel);
            break;
        }
        case CLAP_EVENT_PARAM_VALUE: {
            const clap_event_param_value_t *param = (const clap_event_param_value_t *) header;
            if (param->param_id == PARAM_GAIN) {sine->gain = param->value;}
            break;
        }
        default:
            break;
    }
}

static void render(Sine *sine, float *left, float *right, uint32_t from, uint32_t to) {
    const double attack = 1.0 / (ATTACK_SECONDS * sine->sample_rate);
    const double release = 1.0 / (RELEASE_SECONDS * sine->sample_rate);
    for (uint32_t frame = from; frame < to; frame++) {
        double sum = 0.0;
        for (int i = 0; i < VOICES; i++) {
            Voice *voice = &sine->voices[i];
            if (!voice->active) {continue;}
            if (voice->released) {
                voice->level -= release;
                if (voice->level <= 0.0) {
                    voice->active = 0;
                    continue;
                }
            } else if (voice->level < 1.0) {
                voice->level = fmin(1.0, voice->level + attack);
            }
            sum += sin(voice->phase * 2.0 * M_PI) * voice->level * voice->velocity;
            voice->phase += voice->increment;
            if (voice->phase >= 1.0) {voice->phase -= 1.0;}
        }
        const float sample = (float) (sum * sine->gain * 0.25);
        left[frame] = sample;
        right[frame] = sample;
    }
}

static bool sine_init(const clap_plugin_t *plugin) {
    Sine *sine = (Sine *) plugin->plugin_data;
    const clap_host_t *host = sine->host;
    sine->host_params = (const clap_host_params_t *) host->get_extension(host, CLAP_EXT_PARAMS);
    sine->host_webview = (const clap_host_webview_t *) host->get_extension(host, CLAP_EXT_WEBVIEW);
    sine->host_gui = (const clap_host_gui_t *) host->get_extension(host, CLAP_EXT_GUI);
    sine->host_hovered = (const clap_host_param_hovered_t *) host->get_extension(host, CLAP_EXT_PARAM_HOVERED);
    return true;
}

static void sine_destroy(const clap_plugin_t *plugin) {free(plugin->plugin_data);}

static bool sine_activate(const clap_plugin_t *plugin, double sample_rate, uint32_t min_frames, uint32_t max_frames) {
    (void) min_frames;
    (void) max_frames;
    ((Sine *) plugin->plugin_data)->sample_rate = sample_rate;
    return true;
}

static void sine_deactivate(const clap_plugin_t *plugin) {(void) plugin;}

static bool sine_start_processing(const clap_plugin_t *plugin) {(void) plugin; return true;}

static void sine_stop_processing(const clap_plugin_t *plugin) {(void) plugin;}

static void sine_reset(const clap_plugin_t *plugin) {
    Sine *sine = (Sine *) plugin->plugin_data;
    memset(sine->voices, 0, sizeof(sine->voices));
}

static clap_process_status sine_process(const clap_plugin_t *plugin, const clap_process_t *process) {
    Sine *sine = (Sine *) plugin->plugin_data;
    if (process->audio_outputs_count < 1 || process->audio_outputs[0].channel_count < 2) {return CLAP_PROCESS_ERROR;}
    float *left = process->audio_outputs[0].data32[0];
    float *right = process->audio_outputs[0].data32[1];
    const uint32_t frames = process->frames_count;
    const uint32_t count = process->in_events->size(process->in_events);
    uint32_t position = 0;
    for (uint32_t index = 0; index < count; index++) {
        const clap_event_header_t *header = process->in_events->get(process->in_events, index);
        const uint32_t time = header->time < frames ? header->time : frames;
        if (time > position) {
            render(sine, left, right, position, time);
            position = time;
        }
        handle_event(sine, header);
    }
    render(sine, left, right, position, frames);
    drain_out_events(sine, process->out_events);
    uint32_t active = 0;
    for (int i = 0; i < VOICES; i++) {if (sine->voices[i].active) {active++;}}
    sine->active_voices = active;
    return CLAP_PROCESS_CONTINUE;
}

static uint32_t audio_ports_count(const clap_plugin_t *plugin, bool is_input) {(void) plugin; return is_input ? 0 : 1;}

static bool audio_ports_get(const clap_plugin_t *plugin, uint32_t index, bool is_input, clap_audio_port_info_t *info) {
    (void) plugin;
    if (is_input || index > 0) {return false;}
    info->id = 0;
    strcpy(info->name, "Output");
    info->flags = CLAP_AUDIO_PORT_IS_MAIN;
    info->channel_count = 2;
    info->port_type = CLAP_PORT_STEREO;
    info->in_place_pair = CLAP_INVALID_ID;
    return true;
}

static const clap_plugin_audio_ports_t audio_ports = {.count = audio_ports_count, .get = audio_ports_get};

static uint32_t note_ports_count(const clap_plugin_t *plugin, bool is_input) {(void) plugin; return is_input ? 1 : 0;}

static bool note_ports_get(const clap_plugin_t *plugin, uint32_t index, bool is_input, clap_note_port_info_t *info) {
    (void) plugin;
    if (!is_input || index > 0) {return false;}
    info->id = 0;
    info->supported_dialects = CLAP_NOTE_DIALECT_CLAP | CLAP_NOTE_DIALECT_MIDI;
    info->preferred_dialect = CLAP_NOTE_DIALECT_CLAP;
    strcpy(info->name, "Notes");
    return true;
}

static const clap_plugin_note_ports_t note_ports = {.count = note_ports_count, .get = note_ports_get};

static uint32_t params_count(const clap_plugin_t *plugin) {(void) plugin; return 1;}

static bool params_get_info(const clap_plugin_t *plugin, uint32_t index, clap_param_info_t *info) {
    (void) plugin;
    if (index > 0) {return false;}
    memset(info, 0, sizeof(*info));
    info->id = PARAM_GAIN;
    info->flags = CLAP_PARAM_IS_AUTOMATABLE;
    strcpy(info->name, "Gain");
    info->min_value = 0.0;
    info->max_value = 1.0;
    info->default_value = 0.8;
    return true;
}

static bool params_get_value(const clap_plugin_t *plugin, clap_id id, double *value) {
    if (id != PARAM_GAIN) {return false;}
    *value = ((Sine *) plugin->plugin_data)->gain;
    return true;
}

static bool params_value_to_text(const clap_plugin_t *plugin, clap_id id, double value, char *text, uint32_t size) {
    (void) plugin;
    if (id != PARAM_GAIN || size < 8) {return false;}
    const int percent = (int) lround(value * 100.0);
    const int digits = percent >= 100 ? 3 : percent >= 10 ? 2 : 1;
    for (int i = digits - 1, rest = percent; i >= 0; i--, rest /= 10) {text[i] = (char) ('0' + rest % 10);}
    text[digits] = '%';
    text[digits + 1] = '\0';
    return true;
}

static bool params_text_to_value(const clap_plugin_t *plugin, clap_id id, const char *text, double *value) {
    (void) plugin;
    if (id != PARAM_GAIN) {return false;}
    *value = fmin(1.0, fmax(0.0, atof(text) / 100.0));
    return true;
}

static void params_flush(const clap_plugin_t *plugin, const clap_input_events_t *in, const clap_output_events_t *out) {
    Sine *sine = (Sine *) plugin->plugin_data;
    const uint32_t count = in->size(in);
    for (uint32_t index = 0; index < count; index++) {handle_event(sine, in->get(in, index));}
    drain_out_events(sine, out);
}

static const clap_plugin_params_t params = {
    .count = params_count,
    .get_info = params_get_info,
    .get_value = params_get_value,
    .value_to_text = params_value_to_text,
    .text_to_value = params_text_to_value,
    .flush = params_flush
};

static int32_t write_uri(const char *page, uint32_t length, char *uri, uint32_t capacity) {
    if (capacity > 0 && uri != NULL) {snprintf(uri, capacity, "%s", page);}
    return (int32_t) length;
}

// webview: the big window, the page every host shows
static int32_t webview_get_uri(const clap_plugin_t *plugin, char *uri, uint32_t capacity) {
    (void) plugin;
    static const char page[] = "/index.html";
    return write_uri(page, sizeof(page), uri, capacity);
}

static bool webview_get_resource(const clap_plugin_t *plugin, const char *path, char *mime, uint32_t capacity,
                                 const clap_ostream_t *stream) {
    (void) plugin; (void) path; (void) mime; (void) capacity; (void) stream;
    return false;
}

static void send_status(Sine *sine) {
    uint8_t message[16];
    memset(message, 0, sizeof(message));
    message[0] = PLUGIN_STATUS;
    message[1] = (uint8_t) sine->active_voices;
    memcpy(message + 8, &sine->gain, 8);
    sine->host_webview->send(sine->host, message, sizeof(message));
}

static void page_param(Sine *sine, uint16_t type, const uint8_t *bytes, uint32_t size) {
    clap_id id;
    if (size < 8) {return;}
    memcpy(&id, bytes + 4, 4);
    if (id != PARAM_GAIN) {return;}
    double value = sine->gain;
    if (type == CLAP_EVENT_PARAM_VALUE) {
        if (size < 16) {return;}
        memcpy(&value, bytes + 8, 8);
        value = fmin(1.0, fmax(0.0, value));
        sine->gain = value;
    }
    push_out_event(sine, type, id, value);
    if (sine->host_params != NULL) {sine->host_params->request_flush(sine->host);}
}

static bool webview_receive(const clap_plugin_t *plugin, const void *buffer, uint32_t size) {
    Sine *sine = (Sine *) plugin->plugin_data;
    const uint8_t *bytes = (const uint8_t *) buffer;
    if (size < 1 || sine->host_webview == NULL) {return false;}
    switch (bytes[0]) {
        case PAGE_POLL:
            send_status(sine);
            return true;
        case PAGE_PARAM_BEGIN:
            page_param(sine, CLAP_EVENT_PARAM_GESTURE_BEGIN, bytes, size);
            return true;
        case PAGE_PARAM_SET:
            page_param(sine, CLAP_EVENT_PARAM_VALUE, bytes, size);
            return true;
        case PAGE_PARAM_END:
            page_param(sine, CLAP_EVENT_PARAM_GESTURE_END, bytes, size);
            return true;
        case PAGE_OPEN_WINDOW:
            return sine->host_gui != NULL && sine->host_gui->request_show(sine->host);
        case PAGE_CLOSE_WINDOW:
            return sine->host_gui != NULL && sine->host_gui->request_hide(sine->host);
        case PAGE_HOVER: {
            clap_id id;
            if (size < 8 || sine->host_hovered == NULL) {return false;}
            memcpy(&id, bytes + 4, 4);
            sine->host_hovered->update(sine->host, id == PARAM_GAIN ? id : CLAP_INVALID_ID);
            return true;
        }
        default:
            return false;
    }
}

static const clap_plugin_webview_t webview = {
    .get_uri = webview_get_uri, .get_resource = webview_get_resource, .receive = webview_receive
};

// gui: only the webview api, the host owns the window, sizes are logical pixels
static bool gui_is_api_supported(const clap_plugin_t *plugin, const char *api, bool is_floating) {
    (void) plugin; (void) is_floating;
    return strcmp(api, CLAP_WINDOW_API_WEBVIEW) == 0;
}

static bool gui_get_preferred_api(const clap_plugin_t *plugin, const char **api, bool *is_floating) {
    (void) plugin;
    *api = CLAP_WINDOW_API_WEBVIEW;
    *is_floating = false;
    return true;
}

static bool gui_create(const clap_plugin_t *plugin, const char *api, bool is_floating) {
    return gui_is_api_supported(plugin, api, is_floating);
}

static void gui_destroy(const clap_plugin_t *plugin) {(void) plugin;}

static bool gui_set_scale(const clap_plugin_t *plugin, double scale) {(void) plugin; (void) scale; return false;}

static bool gui_get_size(const clap_plugin_t *plugin, uint32_t *width, uint32_t *height) {
    const Sine *sine = (const Sine *) plugin->plugin_data;
    *width = sine->gui_width;
    *height = sine->gui_height;
    return true;
}

static bool gui_can_resize(const clap_plugin_t *plugin) {(void) plugin; return true;}

static bool gui_get_resize_hints(const clap_plugin_t *plugin, clap_gui_resize_hints_t *hints) {
    (void) plugin;
    hints->can_resize_horizontally = true;
    hints->can_resize_vertically = true;
    hints->preserve_aspect_ratio = false;
    hints->aspect_ratio_width = 0;
    hints->aspect_ratio_height = 0;
    return true;
}

static bool gui_adjust_size(const clap_plugin_t *plugin, uint32_t *width, uint32_t *height) {
    (void) plugin;
    if (*width < GUI_MIN_WIDTH) {*width = GUI_MIN_WIDTH;}
    if (*height < GUI_MIN_HEIGHT) {*height = GUI_MIN_HEIGHT;}
    return true;
}

static bool gui_set_size(const clap_plugin_t *plugin, uint32_t width, uint32_t height) {
    Sine *sine = (Sine *) plugin->plugin_data;
    gui_adjust_size(plugin, &width, &height);
    sine->gui_width = width;
    sine->gui_height = height;
    return true;
}

static bool gui_set_parent(const clap_plugin_t *plugin, const clap_window_t *window) {(void) plugin; (void) window; return true;}

static bool gui_set_transient(const clap_plugin_t *plugin, const clap_window_t *window) {(void) plugin; (void) window; return false;}

static void gui_suggest_title(const clap_plugin_t *plugin, const char *title) {(void) plugin; (void) title;}

static bool gui_show(const clap_plugin_t *plugin) {(void) plugin; return true;}

static bool gui_hide(const clap_plugin_t *plugin) {(void) plugin; return true;}

static const clap_plugin_gui_t gui = {
    .is_api_supported = gui_is_api_supported, .get_preferred_api = gui_get_preferred_api, .create = gui_create,
    .destroy = gui_destroy, .set_scale = gui_set_scale, .get_size = gui_get_size, .can_resize = gui_can_resize,
    .get_resize_hints = gui_get_resize_hints, .adjust_size = gui_adjust_size, .set_size = gui_set_size,
    .set_parent = gui_set_parent, .set_transient = gui_set_transient, .suggest_title = gui_suggest_title,
    .show = gui_show, .hide = gui_hide
};

// device panel: the same page, the query tells it to draw the compact view
static int32_t panel_get_uri(const clap_plugin_t *plugin, char *uri, uint32_t capacity) {
    (void) plugin;
    static const char page[] = "/index.html?panel";
    return write_uri(page, sizeof(page), uri, capacity);
}

static bool panel_get_width(const clap_plugin_t *plugin, uint32_t height, uint32_t *width) {
    (void) plugin; (void) height;
    *width = PANEL_WIDTH;
    return true;
}

static const opendaw_plugin_device_panel_t device_panel = {.get_uri = panel_get_uri, .get_width = panel_get_width};

static const void *sine_get_extension(const clap_plugin_t *plugin, const char *id) {
    (void) plugin;
    if (strcmp(id, CLAP_EXT_AUDIO_PORTS) == 0) {return &audio_ports;}
    if (strcmp(id, CLAP_EXT_NOTE_PORTS) == 0) {return &note_ports;}
    if (strcmp(id, CLAP_EXT_PARAMS) == 0) {return &params;}
    if (strcmp(id, CLAP_EXT_WEBVIEW) == 0) {return &webview;}
    if (strcmp(id, CLAP_EXT_GUI) == 0) {return &gui;}
#ifndef OMIT_PANEL_EXTENSION
    if (strcmp(id, OPENDAW_EXT_DEVICE_PANEL) == 0) {return &device_panel;}
#endif
    return NULL;
}

static void sine_on_main_thread(const clap_plugin_t *plugin) {(void) plugin;}

static const clap_plugin_t *create(const clap_plugin_factory_t *factory, const clap_host_t *host, const char *plugin_id) {
    (void) factory;
    if (strcmp(plugin_id, descriptor.id) != 0) {return NULL;}
    Sine *sine = (Sine *) calloc(1, sizeof(Sine));
    if (sine == NULL) {return NULL;}
    sine->host = host;
    sine->sample_rate = 48000.0;
    sine->gain = 0.8;
    sine->gui_width = GUI_WIDTH;
    sine->gui_height = GUI_HEIGHT;
    sine->plugin.desc = &descriptor;
    sine->plugin.plugin_data = sine;
    sine->plugin.init = sine_init;
    sine->plugin.destroy = sine_destroy;
    sine->plugin.activate = sine_activate;
    sine->plugin.deactivate = sine_deactivate;
    sine->plugin.start_processing = sine_start_processing;
    sine->plugin.stop_processing = sine_stop_processing;
    sine->plugin.reset = sine_reset;
    sine->plugin.process = sine_process;
    sine->plugin.get_extension = sine_get_extension;
    sine->plugin.on_main_thread = sine_on_main_thread;
    return &sine->plugin;
}

static uint32_t plugin_count(const clap_plugin_factory_t *factory) {(void) factory; return 1;}

static const clap_plugin_descriptor_t *plugin_descriptor(const clap_plugin_factory_t *factory, uint32_t index) {
    (void) factory;
    return index == 0 ? &descriptor : NULL;
}

static const clap_plugin_factory_t factory = {
    .get_plugin_count = plugin_count,
    .get_plugin_descriptor = plugin_descriptor,
    .create_plugin = create
};

static bool entry_init(const char *path) {(void) path; return true;}

static void entry_deinit(void) {}

static const void *entry_get_factory(const char *id) {
    return strcmp(id, CLAP_PLUGIN_FACTORY_ID) == 0 ? &factory : NULL;
}

CLAP_EXPORT const clap_plugin_entry_t clap_entry = {
    .clap_version = CLAP_VERSION_INIT,
    .init = entry_init,
    .deinit = entry_deinit,
    .get_factory = entry_get_factory
};
