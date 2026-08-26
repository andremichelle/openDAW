"""Perceptual scorer via VGGish embeddings (neural audio features), no FAD/sqrtm.
For each ~0.5s window of the RENDER, distance to the nearest window of the SOURCE content
manifold. A clean stretch stays on the manifold (every window still sounds like the material);
grain restarts, breathing and ghosts push windows OFF it. Score = mean render->source nearest
cosine distance. Content-agnostic, length-agnostic. Model cached once."""
import sys, numpy as np, torch, warnings
warnings.filterwarnings("ignore")
_model = None
def _vggish():
    global _model
    if _model is None:
        _model = torch.hub.load('harritaylor/torchvggish', 'vggish', trust_repo=True, verbose=False)
        _model.eval()
    return _model

def _read(path):
    import struct
    b = open(path, 'rb').read(); i = 12; data=None; ch=2; rate=48000
    while i+8 <= len(b):
        cid=b[i:i+4]; size=struct.unpack('<I', b[i+4:i+8])[0]; body=b[i+8:i+8+size]
        if cid==b'fmt ': ch=struct.unpack('<H',body[2:4])[0]; rate=struct.unpack('<I',body[4:8])[0]; fmt=struct.unpack('<H',body[0:2])[0]
        elif cid==b'data': data=body
        i+=8+size+(size&1)
    n=len(data)//4 if fmt==3 else len(data)//2
    if fmt==3: vals=np.frombuffer(data, dtype='<f4')
    else: vals=np.frombuffer(data, dtype='<i2').astype(np.float32)/32768.0
    mono = vals.reshape(-1, ch).mean(axis=1)
    return mono, rate

def _embed(path):
    mono, rate = _read(path)
    with torch.no_grad():
        emb = _vggish()(mono, fs=rate)
    e = emb.detach().cpu().numpy()
    if e.ndim == 1: e = e[None, :]
    return e / (np.linalg.norm(e, axis=1, keepdims=True) + 1e-9)

def score(render, source):
    r = _embed(render); s = _embed(source)
    sims = r @ s.T                    # cosine sim, render x source
    nearest = sims.max(axis=1)        # best source match per render window
    return float((1.0 - nearest).mean())

if __name__ == "__main__":
    print(f"{score(sys.argv[1], sys.argv[2]):.4f}")
