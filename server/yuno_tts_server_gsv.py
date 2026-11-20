# -*- coding: utf-8 -*-
"""
yuno_tts_server_gsv —— 用 GPT-SoVITS v2Pro 当引擎，接口跟 yuno_tts_server.py 保持一致。

  GET  /health   -> {ready, loading, error, device, rtf, voices, voice}
  GET  /voices   -> {voices, voice}
  POST /tts      {text, voice?, lang?, out, prompt_text?, prompt_lang?} -> {ok, out, seconds, audioSeconds, rtf}
  POST /shutdown -> {ok}

和 IndexTTS 版的区别：
  - 模型来自 GPT-SoVITS 整合包（TTS_infer_pack），默认 v2Pro 的 SoVITS + v2 的 s1；
  - 参考音频必须 3~10 秒，超了它直接抛异常（这里先截断到 10 秒再送）；
  - 合成完做一次响度归一化（它输出偏小，RMS 约 -24 dB）。
"""
import argparse
import json
import os
import re
import sys
import threading
import time
import traceback
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

import numpy as np

TARGET_RMS_DB = -18.0
MAX_REF_SECONDS = 10.0
MIN_REF_SECONDS = 3.0

DEFAULT_PROMPT = 'あたし勝手に出ちゃうよ?もしもーし、電話鳴ってるけど、早く出た方がいいんじゃないの?うーん、これはダメだわ'

_lock = threading.Lock()


def log(msg):
    print('[gsv %s] %s' % (time.strftime('%H:%M:%S'), msg), flush=True)


def read_wav(path):
    with wave.open(path, 'rb') as w:
        sr = w.getframerate()
        n = w.getnframes()
        ch = w.getnchannels()
        raw = w.readframes(n)
    data = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0
    if ch > 1:
        data = data.reshape(-1, ch).mean(axis=1)
    return data, sr


def write_wav(path, data, sr):
    data = np.clip(data, -1.0, 1.0)
    pcm = (data * 32767.0).astype('<i2').tobytes()
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm)


def wav_seconds(path):
    try:
        with wave.open(path, 'rb') as w:
            return w.getnframes() / float(w.getframerate())
    except Exception:
        return 0.0


def normalize(data, target_db=TARGET_RMS_DB):
    rms = float(np.sqrt((data ** 2).mean() + 1e-12))
    gain = 10 ** ((target_db - 20 * np.log10(rms)) / 20)
    data = data * gain
    peak = float(np.abs(data).max())
    if peak > 0.95:
        data = data * (0.95 / peak)
    return data


class Translator(object):
    """本地中→日翻译（Qwen2.5-1.5B-Instruct，懒加载）。跟 IndexTTS 版是同一个提示词。"""

    SYSTEM = (
        '你是动画角色的台词翻译。把中文翻成日语口语（常体），像冷淡、话少、有点懒的女生在自言自语。\n\n'
        '硬性要求：\n'
        '- 一律常体：だ／た／よ／ね／な／から。绝不用「です・ます・ください・いただけますか」\n'
        '- 一句对一句：不合并、不扩写、不丢句\n'
        '- 保留省略号、停顿、省略句\n'
        '- 只输出译文，不解释、不加引号、不留中文\n\n'
        '示例：\n'
        '中文：嗯，在。用が有ったら言って。\n'
        '日语：うん、いるよ。用があったら言って。\n'
        '中文：这个报错怎么修？先把最后几行日志贴出来。\n'
        '日语：このエラー、どう直すの。まず最後の数行のログを貼って。\n'
        '中文：剩下的我接，你去躺着。\n'
        '日语：あとは私がやる。寝てな。\n'
        '中文：麻烦。不过做完了，刷新一下就行。\n'
        '日语：めんどくさい。でも終わったから、更新すればいい。'
    )

    def __init__(self, model='Qwen/Qwen2.5-1.5B-Instruct', cache_home='', device='cpu'):
        self.model_id = model
        self.cache_home = cache_home
        self.device = device
        self.lock = threading.RLock()
        self.tok = None
        self.model = None
        self.error = ''
        self.loading = False

    def state(self):
        return {'ready': self.model is not None, 'loading': self.loading,
                'error': self.error, 'device': self.device}

    def ensure(self):
        if self.model is not None:
            return
        with self.lock:
            if self.model is not None:
                return
            self.loading = True
            t0 = time.time()
            try:
                os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')
                os.environ.setdefault('HF_HUB_DISABLE_XET', '1')
                if self.cache_home:
                    os.environ['HF_HOME'] = self.cache_home
                import torch
                from transformers import AutoModelForCausalLM, AutoTokenizer
                tok = AutoTokenizer.from_pretrained(self.model_id)
                dtype = torch.float16 if self.device.startswith('cuda') else torch.float32
                model = AutoModelForCausalLM.from_pretrained(self.model_id, torch_dtype=dtype)
                model.eval()
                if self.device.startswith('cuda'):
                    model = model.to(self.device)
                self.tok = tok
                self.model = model
                log('翻译模型就绪（%s，%.1fs）' % (self.device, time.time() - t0))
            except Exception:
                self.error = traceback.format_exc(limit=3).strip().splitlines()[-1]
                log('翻译模型加载失败：' + self.error)
                raise
            finally:
                self.loading = False

    @staticmethod
    def _clean(reply):
        text = (reply or '').strip().split('\n')[0].strip()
        for a, b in (('「', '」'), ('『', '』'), ('"', '"'), ('“', '”'), ("'", "'")):
            if text.startswith(a) and text.endswith(b) and len(text) > 2:
                text = text[1:-1].strip()
        for prefix in ('日语：', '日文：', '訳：', 'Japanese:', 'JA:'):
            if text.startswith(prefix):
                text = text[len(prefix):].strip()
        return text

    def translate(self, text, to='ja'):
        text = (text or '').strip()
        if not text:
            raise ValueError('text 为空')
        self.ensure()
        import torch
        with self.lock:
            t0 = time.time()
            messages = [{'role': 'system', 'content': self.SYSTEM}, {'role': 'user', 'content': text}]
            prompt = self.tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
            inputs = self.tok(prompt, return_tensors='pt')
            if self.device.startswith('cuda'):
                inputs = {k: v.to(self.device) for k, v in inputs.items()}
            with torch.no_grad():
                out = self.model.generate(
                    **inputs,
                    max_new_tokens=max(160, min(640, len(text) * 4)),
                    do_sample=False,
                    pad_token_id=self.tok.eos_token_id,
                )
            reply = self.tok.decode(out[0][inputs['input_ids'].shape[1]:], skip_special_tokens=True)
            result = self._clean(reply)
            if not result:
                raise RuntimeError('翻译结果为空')
            return {'ok': True, 'text': result, 'source': text, 'seconds': round(time.time() - t0, 2)}


class Engine:
    def __init__(self, args):
        self.args = args
        self.ready = False
        self.loading = False
        self.error = ''
        self.device = '?'
        self.tts = None
        self.last_rtf = 0.0
        self.load_seconds = 0.0
        self.voices = []
        self.voice = ''
        self.prompts = {}
        self.translator = Translator(
            model=args.translate_model or '',
            cache_home=args.translate_home or '',
            device=args.translate_device or 'cpu',
        )
        self._load_prompts()

    def _load_prompts(self):
        p = self.args.prompts
        if p and os.path.isfile(p):
            try:
                with open(p, encoding='utf-8') as f:
                    self.prompts = json.load(f)
            except Exception:
                log('prompts 读取失败：' + traceback.format_exc(limit=2))

    def refresh_voices(self):
        d = self.args.voice_dir
        out = []
        if d and os.path.isdir(d):
            for name in sorted(os.listdir(d)):
                if re.search(r'\.(wav|mp3|flac|m4a|ogg)$', name, re.I):
                    out.append(os.path.join(d, name))
        self.voices = out
        if not self.voice:
            self.voice = self.args.voice if (self.args.voice and os.path.isfile(self.args.voice)) else (out[0] if out else '')

    # 交付包的四套语气参考：按句子特征自动挑，换语气不用换模型。
    # 优先级：疑问 > 迟疑 > 直白 > 自然日常。
    TONE_REF = {
        'natural': 'pack-natural-01.wav',
        'think': 'pack-think-01.wav',
        'query': 'pack-query-01.wav',
        'suggest': 'pack-suggest-01.wav',
    }

    def _tone_of(self, text):
        t = text or ''
        if any(c in t for c in '？?'):
            return 'query'
        if '……' in t or '...' in t or '⋯' in t:
            return 'think'
        if any(c in t for c in '！!') or t.rstrip().endswith('ね') or t.rstrip().endswith('よ'):
            return 'suggest'
        return 'natural'

    def pick_voice(self, text, voice=None):
        """没指定音色时，按句子语气挑一套参考。"""
        if voice:
            return voice
        tone = self._tone_of(text)
        name = self.TONE_REF.get(tone) or self.TONE_REF['natural']
        for v in self.voices:
            if os.path.basename(v) == name:
                return v
        return self.voice

    def resolve_voice(self, voice):
        self.refresh_voices()
        if voice and os.path.isfile(voice):
            return voice
        if self.voice and os.path.isfile(self.voice):
            return self.voice
        if self.voices:
            self.voice = self.voices[0]
            return self.voice
        raise RuntimeError('没有可用的参考音频')

    def start(self):
        threading.Thread(target=self._load, name='load', daemon=True).start()

    def _load(self):
        t0 = time.time()
        self.loading = True
        try:
            root = os.path.abspath(self.args.root)
            os.chdir(root)
            for p in (root, os.path.join(root, 'GPT_SoVITS')):
                if p not in sys.path:
                    sys.path.insert(0, p)
            from TTS_infer_pack.TTS import TTS, TTS_Config

            self.refresh_voices()
            cfg_path = self.args.config or os.path.join(root, 'GPT_SoVITS', 'configs', 'tts_infer.yaml')
            log('加载 GPT-SoVITS … config=%s' % cfg_path)
            tts_config = TTS_Config(cfg_path)
            tts_config.device = self.args.device or tts_config.device
            tts_config.is_half = True
            self.device = tts_config.device
            self.tts = TTS(tts_config)
            if self.args.gpt_weights:
                self.tts.init_t2s_weights(self.args.gpt_weights)
                log('t2s 权重：%s' % os.path.basename(self.args.gpt_weights))
            if self.args.sovits_weights:
                self.tts.init_vits_weights(self.args.sovits_weights)
                log('vits 权重：%s' % os.path.basename(self.args.sovits_weights))
            self.load_seconds = round(time.time() - t0, 1)
            log('就绪，用时 %.1fs，device=%s' % (self.load_seconds, self.device))
            # 预热：第一次推理要编译 kernel、算参考 embedding；不预热第一条要 20 秒
            try:
                tw = time.time()
                self._warming = True
                self.synth('こんにちは。', out=os.path.join(self.args.cache_dir, 'warmup.wav'))
                log('warmup 完成，%.1fs' % (time.time() - tw))
            except Exception:
                log('warmup 跳过：' + traceback.format_exc(limit=3))
            finally:
                self._warming = False
            self.ready = True
            self.loading = False
            # 翻译模型也顺手预热，别让用户第一次点试听时等它加载
            threading.Thread(target=self._warm_translator, name='warm-tr', daemon=True).start()
        except Exception:
            self.error = traceback.format_exc(limit=6)
            self.loading = False
            log('加载失败：\n' + self.error)

    def _warm_translator(self):
        if not self.args.translate_model:
            return
        try:
            t0 = time.time()
            self.translator.ensure()
            log('翻译模型预热完成，%.1fs' % (time.time() - t0))
        except Exception:
            log('翻译模型预热失败（不影响合成）：' + traceback.format_exc(limit=2))

    def _prompt_for(self, voice):
        base = os.path.basename(voice)
        if base in self.prompts:
            return self.prompts[base]
        return DEFAULT_PROMPT

    def synth(self, text, voice=None, lang='ja', out=None, prompt_text=None, opts=None):
        opts = opts or {}
        if not self.ready and not getattr(self, '_warming', False):
            raise RuntimeError('模型还没就绪' + ('：' + self.error.strip().splitlines()[-1] if self.error else ''))
        text = (text or '').strip()
        if not text:
            raise ValueError('text 为空')
        # 没指定音色时按句子语气自动挑参考（疑问/迟疑/直白/日常）
        if not voice:
            voice = self.pick_voice(text)
        spk = self.resolve_voice(voice)
        data, sr = read_wav(spk)
        sec = len(data) / sr
        if sec > MAX_REF_SECONDS:
            data = data[: int(MAX_REF_SECONDS * sr)]
            spk_tmp = spk + '.clip.wav'
            write_wav(spk_tmp, data, sr)
            spk = spk_tmp
            log('参考音频 %.1fs 超长，截到 %.0fs' % (sec, MAX_REF_SECONDS))
        prompt = prompt_text or self._prompt_for(voice or spk)

        req = {
            'text': text,
            'text_lang': lang,
            'ref_audio_path': spk,
            'prompt_text': prompt,
            'prompt_lang': lang,
            'top_k': int(opts.get('top_k', 8)),
            'top_p': float(opts.get('top_p', 0.9)),
            'temperature': float(opts.get('temperature', 0.8)),
            'text_split_method': opts.get('text_split_method') or 'cut2',
            'batch_size': 1,
            'batch_threshold': 0.75,
            'split_bucket': True,
            'speed_factor': float(opts.get('speed_factor', 1.1)),
            'fragment_interval': 0.3,
            'seed': int(opts.get('seed', -1)),
            'media_type': 'wav',
            'streaming_mode': False,
            'return_fragment': False,
            'fixed_length_chunk': False,
            'parallel_infer': True,
            'use_cuda_graph': True,
            'repetition_penalty': float(opts.get('repetition_penalty', 1.5)),
            'super_sampling': False,
            'overlap_length': 2,
            'min_chunk_length': 16,
        }
        out = out or os.path.join(self.args.cache_dir, 'out-%d.wav' % int(time.time() * 1000))
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)

        t0 = time.time()
        with _lock:
            gen = self.tts.run(req)
            result = None
            for item in gen:
                if result is None:
                    result = item
                else:
                    result = (result[0], np.concatenate([result[1], item[1]]))
            if result is None:
                raise RuntimeError('合成没有产出')
            sr_out, audio = result
        elapsed = time.time() - t0
        audio = normalize(np.asarray(audio, dtype=np.float32))
        write_wav(out, audio, sr_out)
        audio_seconds = wav_seconds(out)
        rtf = round(elapsed / audio_seconds, 3) if audio_seconds else 0.0
        self.last_rtf = rtf
        return {
            'ok': True,
            'out': out,
            'seconds': round(elapsed, 2),
            'audioSeconds': round(audio_seconds, 2),
            'rtf': rtf,
            'voice': os.path.basename(spk),
            'lang': lang,
        }

    def health(self):
        self.refresh_voices()
        return {
            'ok': True,
            'ready': self.ready,
            'loading': self.loading,
            'error': self.error.strip().splitlines()[-1] if self.error else '',
            'device': self.device,
            'rtf': self.last_rtf,
            'loadSeconds': self.load_seconds,
            'voice': os.path.basename(self.voice) if self.voice else '',
            'voices': [os.path.basename(v) for v in self.voices],
            'translator': self.translator.state(),
        }


def make_handler(engine, server_ref):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            pass

        def _json(self, code, payload):
            body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
            self.send_response(code)
            self.send_header('content-type', 'application/json; charset=utf-8')
            self.send_header('content-length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _body(self):
            n = int(self.headers.get('content-length') or 0)
            if n <= 0:
                return {}
            return json.loads(self.rfile.read(n).decode('utf-8'))

        def do_GET(self):
            path = urlparse(self.path).path
            if path == '/health':
                return self._json(200, engine.health())
            if path == '/voices':
                h = engine.health()
                return self._json(200, {'ok': True, 'voice': h['voice'], 'voices': h['voices']})
            return self._json(404, {'ok': False, 'error': 'not found'})

        def do_POST(self):
            path = urlparse(self.path).path
            try:
                if path == '/shutdown':
                    self._json(200, {'ok': True})
                    threading.Thread(target=server_ref[0].shutdown, daemon=True).start()
                    return
                if path == '/tts':
                    body = self._body()
                    result = engine.synth(
                        body.get('text'),
                        body.get('voice'),
                        body.get('lang') or 'ja',
                        body.get('out'),
                        body.get('prompt_text'),
                        body.get('opts') or {},
                    )
                    return self._json(200, result)
                if path == '/translate':
                    body = self._body()
                    result = engine.translator.translate(body.get('text'), body.get('to') or 'ja')
                    return self._json(200, result)
                return self._json(404, {'ok': False, 'error': 'not found'})
            except Exception as e:
                log('请求出错：' + traceback.format_exc(limit=4))
                return self._json(500, {'ok': False, 'error': str(e)})

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=9802)
    parser.add_argument('--root', default=r'D:\gzq1\gsv\GPT-SoVITS-v2pro-20250604-nvidia50')
    parser.add_argument('--config', default='')
    parser.add_argument('--device', default='')
    parser.add_argument('--voice-dir', default=r'D:\gzq1\yuno')
    parser.add_argument('--voice', default=r'D:\gzq1\yuno\yuno-ref-gsv.wav')
    parser.add_argument('--prompts', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'gsv_voices.json'))
    parser.add_argument('--gpt-weights', default='GPT_SoVITS/pretrained_models/s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt')
    parser.add_argument('--sovits-weights', default='GPT_SoVITS/pretrained_models/v2Pro/s2Gv2Pro.pth')
    parser.add_argument('--cache-dir', default=r'C:\Users\可乐不太行\.dsh\yuno-tts\gsv-cache')
    parser.add_argument('--translate-model', default='')
    parser.add_argument('--translate-home', default='')
    parser.add_argument('--translate-device', default='cpu')
    args = parser.parse_args()

    engine = Engine(args)
    engine.start()
    server_ref = [None]
    httpd = ThreadingHTTPServer(('127.0.0.1', args.port), make_handler(engine, server_ref))
    server_ref[0] = httpd
    log('监听 http://127.0.0.1:%d' % args.port)
    httpd.serve_forever()


if __name__ == '__main__':
    main()
