import json
import os
from typing import Dict, Any


def load_qa_config() -> Dict[str, Any]:
    """Load qa-config.json from the QA harness directory."""
    harness_dir = os.environ.get("QA_HARNESS_DIR")
    if harness_dir:
        config_path = os.path.join(harness_dir, "qa-config.json")
    else:
        config_path = os.path.join(os.path.dirname(__file__), "..", "..", "qa-config.json")

    config_path = os.path.abspath(config_path)
    if not os.path.exists(config_path):
        return {}

    with open(config_path) as f:
        return json.load(f)
