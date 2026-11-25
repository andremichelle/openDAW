// One plugin per port layout, id test.audio-ports.<side><ports>x<channels>, unless the host passes exactly the
// declared ports and channels it writes nothing. "out" layouts have no inputs and write 0.5 / (1 + port * 16 + channel)
// to every frame of every channel. "in" layouts have one stereo output: left is input port 0's first channel, right
// the sum of all other input channels. Built with wasi-sdk:
// clang --target=wasm32-wasip1 -mexec-model=reactor -O2 -I<clap>/include
//       -Wl,--export=malloc -Wl,--export=clap_entry -Wl,--export-table -Wl,--growable-table
//       -o audio-ports.wasm audio-ports.c
#include <clap/clap.h>
#include <stdlib.h>
#include <string.h>

typedef struct {uint32_t ports[2]; uint32_t channels[2];} layout_t; // [0] outputs, [1] inputs

static const layout_t layouts[] = {
    {{1, 0}, {1, 0}}, {{2, 0}, {2, 0}}, {{1, 0}, {8, 0}}, {{1, 0}, {1025, 0}},
    {{1, 1}, {2, 1}}, {{1, 1}, {2, 8}}, {{1, 2}, {2, 2}}
};
#define LAYOUT_COUNT (sizeof(layouts) / sizeof(layouts[0]))

static const char* const features[] = {CLAP_PLUGIN_FEATURE_AUDIO_EFFECT, NULL};

static const clap_plugin_descriptor_t descriptors[LAYOUT_COUNT] = {
#define DESCRIPTOR(shape) {.clap_version = CLAP_VERSION_INIT, .id = "test.audio-ports." shape, .name = "Audio Ports " shape, \
    .vendor = "openDAW", .url = "", .manual_url = "", .support_url = "", .version = "1", .description = "", \
    .features = features}
    DESCRIPTOR("out1x1"), DESCRIPTOR("out2x2"), DESCRIPTOR("out1x8"), DESCRIPTOR("out1x1025"),
    DESCRIPTOR("in1x1"), DESCRIPTOR("in1x8"), DESCRIPTOR("in2x2")
#undef DESCRIPTOR
};

static const layout_t* layout_of(const clap_plugin_t* plugin) {return plugin->plugin_data;}

static uint32_t ports_count(const clap_plugin_t* plugin, bool is_input) {return layout_of(plugin)->ports[is_input];}

static bool ports_get(const clap_plugin_t* plugin, uint32_t index, bool is_input, clap_audio_port_info_t* info) {
    const layout_t* layout = layout_of(plugin);
    if (index >= layout->ports[is_input]) {return false;}
    const uint32_t channels = layout->channels[is_input];
    memset(info, 0, sizeof(*info));
    strcpy(info->name, is_input ? "in" : "out");
    info->id = index;
    info->flags = index == 0 ? CLAP_AUDIO_PORT_IS_MAIN : 0;
    info->channel_count = channels;
    info->port_type = channels == 1 ? CLAP_PORT_MONO : channels == 2 ? CLAP_PORT_STEREO : NULL;
    info->in_place_pair = CLAP_INVALID_ID;
    return true;
}

static const clap_plugin_audio_ports_t audio_ports = {.count = ports_count, .get = ports_get};

static bool plugin_init(const clap_plugin_t* plugin) {return true;}
static void plugin_destroy(const clap_plugin_t* plugin) {free((void*) plugin);}
static bool plugin_activate(const clap_plugin_t* plugin, double rate, uint32_t min, uint32_t max) {return true;}
static void plugin_deactivate(const clap_plugin_t* plugin) {}
static bool plugin_start(const clap_plugin_t* plugin) {return true;}
static void plugin_stop(const clap_plugin_t* plugin) {}
static void plugin_reset(const clap_plugin_t* plugin) {}
static void plugin_on_main_thread(const clap_plugin_t* plugin) {}

static bool matches(const clap_audio_buffer_t* buffers, uint32_t count, uint32_t expected, uint32_t channels) {
    if (count != expected) {return false;}
    for (uint32_t port = 0; port < count; port++) {
        if (buffers[port].channel_count != channels) {return false;}
        for (uint32_t channel = 0; channel < channels; channel++) {
            if (buffers[port].data32[channel] == NULL) {return false;}
        }
    }
    return true;
}

static clap_process_status plugin_process(const clap_plugin_t* plugin, const clap_process_t* process) {
    const layout_t* layout = layout_of(plugin);
    if (!matches(process->audio_outputs, process->audio_outputs_count, layout->ports[0], layout->channels[0])
        || !matches(process->audio_inputs, process->audio_inputs_count, layout->ports[1], layout->channels[1])) {
        return CLAP_PROCESS_ERROR;
    }
    if (layout->ports[1] == 0) {
        for (uint32_t port = 0; port < layout->ports[0]; port++) {
            for (uint32_t channel = 0; channel < layout->channels[0]; channel++) {
                float* out = process->audio_outputs[port].data32[channel];
                const float value = 0.5f / (float) (1 + port * 16 + channel);
                for (uint32_t frame = 0; frame < process->frames_count; frame++) {out[frame] = value;}
            }
        }
        return CLAP_PROCESS_CONTINUE;
    }
    float* left = process->audio_outputs[0].data32[0];
    float* right = process->audio_outputs[0].data32[1];
    for (uint32_t frame = 0; frame < process->frames_count; frame++) {
        float sum = 0.0f;
        for (uint32_t port = 0; port < layout->ports[1]; port++) {
            for (uint32_t channel = port == 0 ? 1 : 0; channel < layout->channels[1]; channel++) {
                sum += process->audio_inputs[port].data32[channel][frame];
            }
        }
        left[frame] = process->audio_inputs[0].data32[0][frame];
        right[frame] = sum;
    }
    return CLAP_PROCESS_CONTINUE;
}

static const void* plugin_get_extension(const clap_plugin_t* plugin, const char* id) {
    return strcmp(id, CLAP_EXT_AUDIO_PORTS) == 0 ? &audio_ports : NULL;
}

static uint32_t factory_count(const clap_plugin_factory_t* factory) {return LAYOUT_COUNT;}

static const clap_plugin_descriptor_t* factory_descriptor(const clap_plugin_factory_t* factory, uint32_t index) {
    return index < LAYOUT_COUNT ? &descriptors[index] : NULL;
}

static const clap_plugin_t* factory_create(const clap_plugin_factory_t* factory, const clap_host_t* host, const char* id) {
    for (uint32_t index = 0; index < LAYOUT_COUNT; index++) {
        if (strcmp(id, descriptors[index].id) != 0) {continue;}
        clap_plugin_t* plugin = calloc(1, sizeof(clap_plugin_t));
        *plugin = (clap_plugin_t) {
            .desc = &descriptors[index], .plugin_data = (void*) &layouts[index], .init = plugin_init,
            .destroy = plugin_destroy, .activate = plugin_activate, .deactivate = plugin_deactivate,
            .start_processing = plugin_start, .stop_processing = plugin_stop, .reset = plugin_reset,
            .process = plugin_process, .get_extension = plugin_get_extension, .on_main_thread = plugin_on_main_thread
        };
        return plugin;
    }
    return NULL;
}

static const clap_plugin_factory_t factory = {
    .get_plugin_count = factory_count, .get_plugin_descriptor = factory_descriptor, .create_plugin = factory_create
};

static bool entry_init(const char* path) {return true;}
static void entry_deinit(void) {}
static const void* entry_get_factory(const char* id) {return strcmp(id, CLAP_PLUGIN_FACTORY_ID) == 0 ? &factory : NULL;}

CLAP_EXPORT const clap_plugin_entry_t clap_entry = {
    .clap_version = CLAP_VERSION_INIT, .init = entry_init, .deinit = entry_deinit, .get_factory = entry_get_factory
};
