# NEXUS shim for Microsoft UFO's `config.config_loader`.
# The vendored UFO controller only reads `ufo_config.system.*` input settings;
# NEXUS supplies those here instead of shipping UFO's YAML config system.
from types import SimpleNamespace

_CONFIG = SimpleNamespace(
    system=SimpleNamespace(
        after_click_wait=None,
        click_api="click_input",          # real mouse input on the control (UFO default)
        input_text_api="set_text",        # UIA ValuePattern first, type_keys fallback
        input_text_enter=False,           # NEXUS decides Enter via `submit`
        input_text_inter_key_pause=0.05,
    )
)


def get_ufo_config():
    return _CONFIG
