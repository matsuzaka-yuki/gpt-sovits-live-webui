"""Private JSON-lines worker. Imports GPT-SoVITS directly; no HTTP server."""
import json
import os
from pathlib import Path
import sys
import traceback

protocol = sys.stdout
sys.stdout = sys.stderr


def send(value):
    protocol.write(json.dumps(value, ensure_ascii=True) + "\n")
    protocol.flush()


def main():
    settings = json.loads(sys.stdin.readline())
    root = Path(settings["rootPath"]).resolve()
    os.chdir(root)
    sys.path[:0] = [str(root), str(root / "GPT_SoVITS")]
    import yaml
    import soundfile as sf
    import numpy as np
    from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config

    with open(settings["configPath"], encoding="utf-8") as source:
        configs = yaml.safe_load(source)
    custom = dict(configs.get("custom", configs.get("v2", {})))
    for source, target in [("gptWeights", "t2s_weights_path"), ("sovitsWeights", "vits_weights_path")]:
        if settings[source]:
            custom[target] = settings[source]
    for key in ["t2s_weights_path", "vits_weights_path", "bert_base_path", "cnhuhbert_base_path"]:
        if not custom.get(key) or not Path(custom[key]).exists():
            raise ValueError(f"Missing model path: {key} = {custom.get(key)}")
    if settings["device"] != "auto":
        custom["device"] = settings["device"]
    if settings["precision"] != "auto":
        custom["is_half"] = settings["precision"] == "half"
    configs["custom"] = custom
    config = TTS_Config(configs)
    # Upstream writes its config when loading weights. Never overwrite the user's YAML.
    config.configs_path = settings["runtimeConfigPath"]
    pipeline = TTS(config)
    send({"ready": True, "device": str(config.device)})
    for line in sys.stdin:
        message = json.loads(line)
        try:
            chunks = list(pipeline.run(message["params"]))
            if not chunks:
                raise RuntimeError("Inference returned no audio")
            rate = chunks[0][0]
            if any(sr != rate for sr, _ in chunks):
                raise RuntimeError("Inconsistent sample rates")
            sf.write(message["output"], np.concatenate([audio for _, audio in chunks]), rate, subtype="PCM_16")
            send({"id": message["id"], "ok": True})
        except Exception as error:
            traceback.print_exc()
            send({"id": message["id"], "error": str(error)})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        traceback.print_exc()
        send({"fatal": str(error)})
        sys.exit(1)
