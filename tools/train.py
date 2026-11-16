"""訓練七段顯示器數字辨識的小型神經網路（只用 numpy）。

用法：
    python3 tools/train.py <資料夾> [輸出 js 檔]

資料由 tools/build-dataset.js 產生（X.u8, y.u8, meta.json）。
模型：輸入 16x24 + 寬高比（385 維）→ 48 個隱藏單元（ReLU）→ 11 類（0–9 與「不是數字」）。
權重以 int8 量化後輸出成 js/digit-model.js（約 25 KB）。
"""
import base64
import json
import sys

import numpy as np

HIDDEN = 48
CLASSES = 11
EPOCHS = 18
BATCH = 256
LR = 2e-3
L2 = 1e-5


def load(folder):
    meta = json.load(open(f"{folder}/meta.json"))
    D = meta["D"]
    X = np.fromfile(f"{folder}/X.u8", dtype=np.uint8).reshape(-1, D).astype(np.float32) / 255.0
    X[:, -1] *= 1.5  # 寬高比特徵在資料檔中除以 1.5 存放
    y = np.fromfile(f"{folder}/y.u8", dtype=np.uint8).astype(np.int64)
    return X, y


def forward(params, X):
    W1, b1, W2, b2 = params
    h = np.maximum(0, X @ W1.T + b1)
    z = h @ W2.T + b2
    return h, z


def softmax(z):
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def accuracy(params, X, y):
    return float((forward(params, X)[1].argmax(1) == y).mean())


def quantize(W):
    scale = np.abs(W).max(axis=1) / 127.0 + 1e-12
    q = np.clip(np.round(W / scale[:, None]), -127, 127).astype(np.int8)
    return q, scale.astype(np.float32)


def main():
    folder = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else "js/digit-model.js"
    X, y = load(folder)
    rng = np.random.default_rng(0)
    idx = rng.permutation(len(y))
    X, y = X[idx], y[idx]
    nval = len(y) // 10
    Xv, yv, Xt, yt = X[:nval], y[:nval], X[nval:], y[nval:]
    print("訓練", len(yt), "驗證", nval, "類別分布", np.bincount(y, minlength=CLASSES))

    # 類別權重（平衡）
    counts = np.bincount(yt, minlength=CLASSES).astype(np.float32)
    cw = (counts.sum() / (CLASSES * np.maximum(counts, 1))) ** 0.5

    D = X.shape[1]
    params = [
        rng.normal(0, np.sqrt(2 / D), (HIDDEN, D)).astype(np.float32),
        np.zeros(HIDDEN, np.float32),
        rng.normal(0, np.sqrt(2 / HIDDEN), (CLASSES, HIDDEN)).astype(np.float32),
        np.zeros(CLASSES, np.float32),
    ]
    m = [np.zeros_like(p) for p in params]
    v = [np.zeros_like(p) for p in params]
    t = 0
    for ep in range(EPOCHS):
        lr = LR * (0.5 * (1 + np.cos(np.pi * ep / EPOCHS)))
        perm = rng.permutation(len(yt))
        for s in range(0, len(perm), BATCH):
            bi = perm[s:s + BATCH]
            xb = Xt[bi]
            # 輕微擾動，增加穩健性
            xb = np.clip(xb + rng.normal(0, 0.04, xb.shape).astype(np.float32), 0, 1.5)
            yb = yt[bi]
            h, z = forward(params, xb)
            p = softmax(z)
            wts = cw[yb]
            g = p.copy()
            g[np.arange(len(yb)), yb] -= 1
            g *= (wts / wts.sum())[:, None]
            W1, b1, W2, b2 = params
            gW2 = g.T @ h + L2 * W2
            gb2 = g.sum(0)
            gh = (g @ W2) * (h > 0)
            gW1 = gh.T @ xb + L2 * W1
            gb1 = gh.sum(0)
            t += 1
            for k, gr in enumerate([gW1, gb1, gW2, gb2]):
                m[k] = 0.9 * m[k] + 0.1 * gr
                v[k] = 0.999 * v[k] + 0.001 * gr * gr
                mh = m[k] / (1 - 0.9 ** t)
                vh = v[k] / (1 - 0.999 ** t)
                params[k] -= lr * mh / (np.sqrt(vh) + 1e-8)
        print(f"epoch {ep + 1:2d}  train {accuracy(params, Xt[:20000], yt[:20000]):.4f}  val {accuracy(params, Xv, yv):.4f}")

    # 量化並驗證
    W1, b1, W2, b2 = params
    q1, s1 = quantize(W1)
    q2, s2 = quantize(W2)
    qparams = [q1.astype(np.float32) * s1[:, None], b1, q2.astype(np.float32) * s2[:, None], b2]
    pred = forward(qparams, Xv)[1].argmax(1)
    print("量化後驗證準確率", float((pred == yv).mean()))
    conf = np.zeros((CLASSES, CLASSES), int)
    for a, b in zip(yv, pred):
        conf[a, b] += 1
    print("混淆矩陣（列=答案，欄=預測）\n", conf)

    def layer(q, s, b):
        return {
            "in": int(q.shape[1]), "out": int(q.shape[0]),
            "w": base64.b64encode(q.tobytes()).decode(),
            "scale": [float(f"{x:.6g}") for x in s],
            "b": [float(f"{x:.6g}") for x in b],
        }

    model = {"version": 1, "input": [16, 24], "classes": "0123456789X",
             "layers": [layer(q1, s1, b1), layer(q2, s2, b2)]}
    with open(out, "w") as f:
        f.write("// 自動產生：tools/train.py（七段顯示器數字辨識，int8 量化 MLP 385→48→11）\n")
        f.write("export const MODEL = ")
        json.dump(model, f, separators=(",", ":"))
        f.write(";\n")
    print("已輸出", out)


if __name__ == "__main__":
    main()
