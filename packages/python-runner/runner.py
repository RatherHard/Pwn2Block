#!/usr/bin/env python3
"""Pwn2Block Python 求值运行器（06 §6、07 §P6）。

一个进程只处理**一个**任务：

    stdin  <- {"requestId": "...", "code": "...", "outputType": "int|bool|bytes|text",
               "inputs": [{"name": "...", "type": "...", "value": {"kind": "...", ...}}]}
    stdout -> 恰好一行 {"requestId": "...", "ok": true, "value": {...}}
               或 {"requestId": "...", "ok": false, "error": {"code": "...", "message": "..."}}

三条硬约束：

1. **stdout 只有协议那一行**。用户代码的 print 一律被捕获丢弃（只计入日志额度），
   绝不允许混进协议流。真正的协议输出在 exec 结束后由原始 stdout 写出。
2. **不回传宿主信息**。错误只给类型、单行说明和用户代码里的行号；完整 traceback、
   运行器自己的路径、环境变量都不出这个进程。
3. **资源限制是尽力而为**。`resource` 可用时设 RLIMIT_AS / RLIMIT_CPU / RLIMIT_NOFILE；
   不可用（如 Windows）时降级为「无硬限制」，由上层（docker 的 --memory/--cpus 或服务端
   超时）兜底。**普通子进程不是隔离完成的证据**（07 §2）：本文件不宣称已隔离，隔离强度
   由 `PWN2BLOCK_PYTHON_BACKEND` 选定的后端决定，见 README.md。
"""

import json
import os
import re
import sys
import traceback

try:
    # Windows 没有 resource：此时不假装设过限制，README 写明降级行为。
    import resource
except ImportError:  # pragma: no cover - 只在非 POSIX 平台走到
    resource = None

# 与 packages/shared/src/limits.ts 一一对应。Python 侧无法 import TS，所以这里是唯一的
# 镜像；改额度必须同时改两边（packages/server/test/python.test.ts 断言镜像一致）。
MAX_OUTPUT_BYTES = 8 * 1024
MAX_LOG_BYTES = 4 * 1024
MAX_INT_DIGITS = 512
DEFAULT_MEMORY_MB = 64
DEFAULT_CPU_SECONDS = 3

# 任务本身的上限：服务端的请求体上限是 1MB，留一倍余量即可。
MAX_REQUEST_BYTES = 2 * 1024 * 1024
# 单条错误说明的字符上限：够定位，又不至于把异常里夹带的路径整段回传。
MAX_MESSAGE_CHARS = 500
# 十进制位数 -> 二进制位数的保守换算：512 位十进制约 1701 比特。
BITS_PER_DIGIT = 3.33
# 设 RLIMIT_AS 时至少给用户代码留这么多地址空间，否则宁可跳过（见 _apply_limits）。
ADDRESS_SPACE_HEADROOM_MB = 16
# 输入个数上限，与 PYTHON_MAX_INPUTS 一致。
MAX_INPUTS = 8

# 编译用户代码时用的虚拟文件名：traceback 里靠它认出「用户代码的第几行」。
USER_FILENAME = '<python-node>'

# 输入名与服务端 Schema 同一条规则（PYTHON_INPUT_NAME_RE）。运行器再校验一次，
# 免得被改过的服务端把 __builtins__ 之类的名字塞进执行命名空间。
INPUT_NAME_RE = re.compile(r'^[a-z][a-z0-9_]{0,15}$')

# 字母表顺序即 de Bruijn 顺序，与 toolkit.ts 的 ALPHABETS 完全一致：
# 改这里会让 Python 与内置节点的偏移值对不上（07 §P7 最后一条）。
ALPHABETS = {
    'lower': 'abcdefghijklmnopqrstuvwxyz',
    'upper': 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    'digits': '0123456789',
}

# 子串宽度与 pwntools 默认值一致。
CYCLIC_SUBSEQUENCE_WIDTH = 4

_TYPE_LABELS = {'int': '整数', 'bool': '布尔', 'bytes': '字节', 'text': '文本'}

_SEQUENCE_CACHE = {}


# ---------------------------------------------------------------------------
# 工具函数：与 packages/shared/src/workflow/toolkit.ts 同一语义
# ---------------------------------------------------------------------------


def _alphabet_of(name):
    """字母表名或原始字符串 -> 字符表。未知名字报错，而不是悄悄换成小写字母。"""
    if isinstance(name, str) and name in ALPHABETS:
        return ALPHABETS[name]
    if isinstance(name, (bytes, bytearray)):
        return bytes(name).decode('latin-1')
    if isinstance(name, str) and name:
        return name
    raise ValueError('字母表不能为空')


def de_bruijn(alphabet, n=CYCLIC_SUBSEQUENCE_WIDTH):
    """生成完整 de Bruijn 序列（长度 k^n），FKM 算法、字典序最小。

    与 toolkit.ts 的 deBruijnSequence 同一算法、同一顺序，所以 cyclic(k) 的开头逐字节相同。
    """
    if isinstance(alphabet, (bytes, bytearray)):
        alphabet = bytes(alphabet).decode('latin-1')
    key = (alphabet, n)
    cached = _SEQUENCE_CACHE.get(key)
    if cached is not None:
        return cached
    k = len(alphabet)
    if k == 0 or n < 1:
        return ''

    a = [0] * (k * n)
    out = []
    append = out.append

    def db(t, p):
        if t > n:
            if n % p == 0:
                for j in range(1, p + 1):
                    append(alphabet[a[j]])
            return
        a[t] = a[t - p]
        db(t + 1, p)
        for j in range(a[t - p] + 1, k):
            a[t] = j
            db(t + 1, t)

    db(1, 1)
    sequence = ''.join(out)
    _SEQUENCE_CACHE[key] = sequence
    return sequence


def cyclic(length, alphabet='lower'):
    """取长度 length 的定位序列；超过一条 de Bruijn 就循环重复（与 toolkit.ts 一致）。"""
    length = int(length)
    if length <= 0:
        return ''
    pattern = de_bruijn(_alphabet_of(alphabet))
    if not pattern:
        return ''
    if length <= len(pattern):
        return pattern[:length]
    return (pattern * (-(-length // len(pattern))))[:length]


def cyclic_find(needle, alphabet='lower'):
    """在定位序列里找 needle 首次出现的偏移；找不到返回 None。

    **不返回 -1**：-1 会混进整数运算，变成「看起来像偏移的错误答案」；None 让调用方必须
    显式处理没找到（与 toolkit.ts 的 cyclicFind 返回 undefined 同一决定）。序列是循环的，
    needle 可以跨接缝，所以末尾接回开头继续找；含字母表外字节的 needle 永远找不到。
    """
    if isinstance(needle, (bytes, bytearray, memoryview)):
        text = bytes(needle).decode('latin-1')
    elif isinstance(needle, str):
        text = needle
    else:
        raise TypeError('needle 必须是 bytes 或 str')
    if not text:
        return None
    sequence = de_bruijn(_alphabet_of(alphabet))
    if not sequence:
        return None
    wrapped = sequence + sequence[: min(len(text) - 1, len(sequence))]
    offset = wrapped.find(text)
    return None if offset < 0 else offset


def _pack(number, size, endian, signed):
    return int(number).to_bytes(size, endian, signed=signed)


def _unpack(data, size, endian, signed):
    if isinstance(data, str):
        raw = data.encode('latin-1')
    else:
        raw = bytes(data)
    if len(raw) > size:
        raise ValueError('需要最多 %d 字节，收到 %d 字节' % (size, len(raw)))
    # 与 pwntools 一致：不足长度一律在右补零（大端也如此，见 unpacker 的 ljust）。
    raw = raw.ljust(size, b'\x00')
    return int.from_bytes(raw, endian, signed=signed)


def p32(number, endian='little', sign=False):
    """pwntools 风格 p32：整数 -> 4 字节小端。超范围抛 OverflowError，不静默截断。"""
    return _pack(number, 4, endian, sign)


def p64(number, endian='little', sign=False):
    """pwntools 风格 p64：整数 -> 8 字节小端。"""
    return _pack(number, 8, endian, sign)


def u32(data, endian='little', sign=False):
    """pwntools 风格 u32：最多 4 字节 -> 整数（不足补零）。"""
    return _unpack(data, 4, endian, sign)


def u64(data, endian='little', sign=False):
    """pwntools 风格 u64：最多 8 字节 -> 整数（不足补零）。"""
    return _unpack(data, 8, endian, sign)


def _flat_into(item, out, word_size, endian):
    if item is None:
        return
    if isinstance(item, (bytes, bytearray, memoryview)):
        out.extend(bytes(item))
        return
    if isinstance(item, bool):
        out.extend(_pack(1 if item else 0, word_size, endian, False))
        return
    if isinstance(item, int):
        out.extend(_pack(item, word_size, endian, False))
        return
    if isinstance(item, str):
        # pwntools 的 flat 把 str 当原始字节（latin-1），不做编码猜测。
        out.extend(item.encode('latin-1'))
        return
    if isinstance(item, dict):
        for value in item.values():
            _flat_into(value, out, word_size, endian)
        return
    try:
        iterator = iter(item)
    except TypeError:
        raise TypeError('flat 不支持 %s' % type(item).__name__) from None
    for value in iterator:
        _flat_into(value, out, word_size, endian)


def flat(*args, word_size=8, endian='little', length=None, fill=b'\x00'):
    """pwntools 风格 flat 的**子集**：bytes / str / 整数 / 布尔 / 列表与生成器。

    整数按 word_size 拼装；给定 length 时补 fill 到该长度，超长则报错（不静默截断）。
    """
    out = bytearray()
    for item in args:
        _flat_into(item, out, int(word_size), endian)
    if length is not None:
        length = int(length)
        if len(out) > length:
            raise ValueError('flat 结果 %d 字节，超过 length=%d' % (len(out), length))
        out.extend(bytes(fill) * (length - len(out)))
    return bytes(out)


def _tools():
    """用户代码可用的工具集合。

    只放**纯函数**：不碰文件、网络、进程或 VM。系统隔离由后端负责，不靠这里删函数
    （07 §2：不以禁用 import 代替系统隔离）。
    """
    return {
        'cyclic': cyclic,
        'cyclic_find': cyclic_find,
        'de_bruijn': de_bruijn,
        'p32': p32,
        'p64': p64,
        'u32': u32,
        'u64': u64,
        'flat': flat,
        'ALPHABETS': dict(ALPHABETS),
    }


# ---------------------------------------------------------------------------
# 输入解码
# ---------------------------------------------------------------------------


class _BadRequest(Exception):
    """任务本身不合法（正常情况由服务端 Schema 拦住，这里是第二道）。"""


def _decode_input(item):
    """{name, type, value} -> Python 值。整数走 int(十进制字符串)，绝不经过 float。"""
    if not isinstance(item, dict):
        raise _BadRequest('输入项必须是 JSON 对象')
    name = item.get('name')
    if not isinstance(name, str) or not INPUT_NAME_RE.match(name):
        raise _BadRequest('输入名不合法')
    port_type = item.get('type')
    value = item.get('value')
    if not isinstance(value, dict) or value.get('kind') != port_type:
        # 服务端 Schema 不交叉校验 type 与 value.kind，运行器必须自己确认，否则会按错的
        # 类型去取值（例如按 int 读 bytes 的字段）。
        raise _BadRequest('输入类型与值不一致')
    if port_type == 'int':
        raw = value.get('value')
        if not isinstance(raw, str):
            raise _BadRequest('整数输入必须是十进制字符串')
        return int(raw, 10)
    if port_type == 'bytes':
        hex_text = value.get('hex')
        if not isinstance(hex_text, str):
            raise _BadRequest('字节输入必须是 hex 字符串')
        return bytes.fromhex(hex_text)
    if port_type == 'text':
        text = value.get('text')
        if not isinstance(text, str):
            raise _BadRequest('文本输入必须是字符串')
        return text
    if port_type == 'bool':
        flag = value.get('value')
        if not isinstance(flag, bool):
            raise _BadRequest('布尔输入必须是 JSON 布尔')
        return flag
    raise _BadRequest('输入类型不在允许范围内')


# ---------------------------------------------------------------------------
# 输出编码
# ---------------------------------------------------------------------------


def _too_large(message):
    return {'code': 'too_large', 'message': message}


def _bad_output(message):
    return {'code': 'bad_output', 'message': message}


def _mismatch(output_type, actual):
    label = _TYPE_LABELS.get(actual, actual)
    expected = _TYPE_LABELS.get(output_type, output_type)
    return 'Python 输出类型是 %s，但节点声明的是 %s' % (label, expected)


def _kind_of(result):
    """Python 值 -> 协议里的 kind 名。bool 必须先判，否则会被当成 int。"""
    if isinstance(result, bool):
        return 'bool'
    if isinstance(result, int):
        return 'int'
    if isinstance(result, (bytes, bytearray, memoryview)):
        return 'bytes'
    if isinstance(result, str):
        return 'text'
    return 'other'


def _encode_output(result, output_type):
    """result -> (EncodedValue, None) 或 (None, error)。类型不符一律 bad_output。"""
    kind = _kind_of(result)
    if kind != output_type:
        return None, _bad_output(_mismatch(output_type, kind))

    if kind == 'int':
        # 先用位数估算挡掉天文数字：str() 超长会抛 ValueError（int_max_str_digits），
        # 那既慢又难归类，不如在转换前就判定 too_large。
        if abs(int(result)).bit_length() > int(MAX_INT_DIGITS * BITS_PER_DIGIT):
            return None, _too_large('整数输出超过 %d 位十进制数字' % MAX_INT_DIGITS)
        try:
            text = str(int(result))
        except ValueError:
            return None, _too_large('整数输出超过 %d 位十进制数字' % MAX_INT_DIGITS)
        if len(text.lstrip('-')) > MAX_INT_DIGITS:
            return None, _too_large('整数输出超过 %d 位十进制数字' % MAX_INT_DIGITS)
        return {'kind': 'int', 'value': text}, None

    if kind == 'bool':
        return {'kind': 'bool', 'value': bool(result)}, None

    if kind == 'bytes':
        raw = bytes(result)
        if len(raw) > MAX_OUTPUT_BYTES:
            return None, _too_large('字节输出超过 %d 字节' % MAX_OUTPUT_BYTES)
        return {'kind': 'bytes', 'hex': raw.hex()}, None

    try:
        encoded = str(result).encode('utf-8')
    except UnicodeEncodeError:
        return None, _bad_output('文本输出无法编码为 UTF-8')
    if len(encoded) > MAX_OUTPUT_BYTES:
        return None, _too_large('文本输出超过 %d 字节' % MAX_OUTPUT_BYTES)
    return {'kind': 'text', 'text': str(result)}, None


# ---------------------------------------------------------------------------
# 日志捕获：用户输出与协议输出必须分离
# ---------------------------------------------------------------------------


class _BoundedWriter:
    """限制写入总量的文本流：超过上限就标记溢出并停止累积（不抛异常、不无界增长）。"""

    encoding = 'utf-8'
    errors = 'replace'

    def __init__(self, limit):
        self.limit = limit
        self.size = 0
        self.overflow = False
        self.chunks = []

    def write(self, data):
        if not isinstance(data, str):
            data = str(data)
        if self.overflow:
            return len(data)
        size = len(data.encode('utf-8', 'replace'))
        if self.size + size > self.limit:
            self.overflow = True
            self.chunks = []
            return len(data)
        self.size += size
        self.chunks.append(data)
        return len(data)

    def flush(self):
        return None

    def isatty(self):
        return False

    def writable(self):
        return True

    def getvalue(self):
        return ''.join(self.chunks)


# ---------------------------------------------------------------------------
# 求值
# ---------------------------------------------------------------------------


def _user_line(exc):
    """异常在**用户代码**里最后停下的行号；定位不到返回 None。"""
    line = None
    for frame in traceback.extract_tb(exc.__traceback__):
        if frame.filename == USER_FILENAME:
            line = frame.lineno
    return line


def _sanitize(text):
    """去掉宿主路径、压成单行、截断：错误说明不回传宿主信息。"""
    for needle in (os.path.abspath(__file__), os.path.dirname(os.path.abspath(__file__)), os.getcwd()):
        if needle and needle not in ('/', '\\'):
            text = text.replace(needle, '<runner>')
    text = ' '.join(text.split())
    return text[:MAX_MESSAGE_CHARS]


def _exception_message(exc):
    """异常 -> 单行说明（取异常类型与消息那一行，不带 traceback）。"""
    try:
        lines = traceback.format_exception_only(type(exc), exc)
    except Exception:
        # 异常对象的 __str__ 自己炸了也不能拖垮协议。
        return type(exc).__name__
    text = ''.join(lines).strip().splitlines()
    last = text[-1] if text else type(exc).__name__
    return _sanitize(last)


def _runtime_error(exc):
    error = {'code': 'runtime', 'message': _exception_message(exc)}
    line = _user_line(exc)
    if line is not None:
        error['line'] = line
    return error


def _syntax_error(exc):
    error = {'code': 'syntax', 'message': _exception_message(exc)}
    line = getattr(exc, 'lineno', None)
    if isinstance(line, int) and line >= 1:
        error['line'] = line
    return error


def evaluate(code, output_type, inputs):
    """跑一段用户代码，返回 (EncodedValue, error) 二元组（成功的那个是 None）。

    inputs 是已解码的 (name, value) 列表。每次求值都用**全新**命名空间，不继承上次的
    全局变量（06 §6）；不读文件、不读环境、不写 stdout。
    """
    namespace = {'__name__': '__python_node__', '__doc__': None, '__package__': None}
    namespace.update(_tools())
    for name, value in inputs:
        # 输入可以覆盖同名工具（用户的显式命名优先），但覆盖不了 result：它必须由代码赋值。
        namespace[name] = value

    try:
        compiled = compile(code, USER_FILENAME, 'exec')
    except SyntaxError as exc:
        return None, _syntax_error(exc)
    except (ValueError, TypeError) as exc:
        # 例如源码里有空字节：解释器给的是 ValueError，对用户来说就是「代码不合法」。
        return None, {'code': 'syntax', 'message': _sanitize(str(exc))}

    try:
        exec(compiled, namespace)
    except SystemExit as exc:
        return None, {'code': 'runtime', 'message': _sanitize('代码调用了 sys.exit（%s）' % exc.code)}
    except BaseException as exc:
        # 用户代码的任何异常（含 KeyboardInterrupt）都必须落成协议错误，不能逃出去。
        return None, _runtime_error(exc)

    if 'result' not in namespace:
        return None, _bad_output('代码没有给 result 赋值')
    return _encode_output(namespace['result'], output_type)


# ---------------------------------------------------------------------------
# 协议
# ---------------------------------------------------------------------------


def _error_payload(request_id, error):
    return {'requestId': request_id, 'ok': False, 'error': error}


def handle_job(job):
    """一个已解析的任务 -> 协议结果（dict）。请求不合法时给出 invalid_request。"""
    if not isinstance(job, dict):
        return _error_payload('', {'code': 'invalid_request', 'message': '任务必须是 JSON 对象'})

    request_id = job.get('requestId')
    if not isinstance(request_id, str) or not request_id or len(request_id) > 64:
        return _error_payload('', {'code': 'invalid_request', 'message': '缺少任务标识'})

    code = job.get('code')
    output_type = job.get('outputType')
    if not isinstance(code, str) or not code:
        return _error_payload(request_id, {'code': 'invalid_request', 'message': '代码不能为空'})
    if output_type not in _TYPE_LABELS:
        return _error_payload(request_id, {'code': 'invalid_request', 'message': '输出类型不在允许范围内'})

    raw_inputs = job.get('inputs', [])
    if not isinstance(raw_inputs, list) or len(raw_inputs) > MAX_INPUTS:
        return _error_payload(request_id, {'code': 'invalid_request', 'message': '输入个数不合法'})

    try:
        inputs = [(item['name'], _decode_input(item)) for item in raw_inputs]
    except _BadRequest as exc:
        return _error_payload(request_id, {'code': 'invalid_request', 'message': str(exc)})
    except (ValueError, TypeError, KeyError) as exc:
        return _error_payload(request_id, {'code': 'invalid_request', 'message': _sanitize(str(exc))})

    captured_out = _BoundedWriter(MAX_LOG_BYTES)
    captured_err = _BoundedWriter(MAX_LOG_BYTES)
    real_out, real_err = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = captured_out, captured_err
    try:
        value, error = evaluate(code, output_type, inputs)
    finally:
        sys.stdout, sys.stderr = real_out, real_err

    if captured_out.overflow or captured_err.overflow:
        return _error_payload(request_id, _too_large('用户日志超过 %d 字节' % MAX_LOG_BYTES))
    if error is not None:
        return _error_payload(request_id, error)
    return {'requestId': request_id, 'ok': True, 'value': value}


def _write_line(stream, payload):
    """协议输出：一行 ASCII JSON（ensure_ascii 让非 ASCII 不依赖 stdout 编码）。"""
    text = json.dumps(payload, ensure_ascii=True, separators=(',', ':'))
    stream.write(text + '\n')
    stream.flush()


def _read_job(stream):
    """从 stdin 读一个任务；超过大小上限或不是合法 JSON 时给出协议错误。"""
    buffer = getattr(stream, 'buffer', None)
    raw = buffer.read(MAX_REQUEST_BYTES + 1) if buffer is not None else b''
    if len(raw) > MAX_REQUEST_BYTES:
        return None, {'code': 'invalid_request', 'message': '任务超过大小上限'}
    try:
        return json.loads(raw.decode('utf-8')), None
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None, {'code': 'invalid_request', 'message': '任务不是合法 JSON'}


# ---------------------------------------------------------------------------
# 资源限制与宿主环境
# ---------------------------------------------------------------------------


def _config_from_env():
    """读运行器自己的配置；读不到就用与 limits.ts 一致的内置默认值。

    必须在 _drop_host_env() 之前调用：之后进程环境里什么都没有。
    """
    memory_mb = DEFAULT_MEMORY_MB
    cpu_seconds = DEFAULT_CPU_SECONDS
    try:
        memory_mb = int(os.environ.get('PWN2BLOCK_RUNNER_MEMORY_MB', DEFAULT_MEMORY_MB))
    except ValueError:
        pass
    try:
        cpu_seconds = int(os.environ.get('PWN2BLOCK_RUNNER_CPU_SECONDS', DEFAULT_CPU_SECONDS))
    except ValueError:
        pass
    return max(1, memory_mb), max(1, cpu_seconds)


def _drop_host_env():
    """清空进程环境：用户代码即使 import os 也看不到宿主凭据。

    -I 已经让解释器忽略 PYTHON* 变量；这里再把整张表清掉，作为「环境只含任务所需配置」
    （07 §P6）的第二道保证，也把 process 后端忘记清环境的风险降到零。
    """
    try:
        os.environ.clear()
    except OSError:  # pragma: no cover - 某些平台不允许改 environ
        pass


def _current_address_space_mb():
    """当前进程已用的地址空间（MB）。非 Linux 或读不到时返回 None。"""
    try:
        with open('/proc/self/status', encoding='ascii', errors='replace') as handle:
            for line in handle:
                if line.startswith('VmSize:'):
                    return int(line.split()[1]) / 1024.0
    except (OSError, ValueError, IndexError):
        return None
    return None


def _apply_limits(memory_mb, cpu_seconds):
    """尽力施加资源限制；返回降级说明（None 表示全部生效）。

    说明文本刻意用 ASCII：stderr 的编码取决于部署环境，写中文可能抛 UnicodeEncodeError，
    那会把一次本来能成功的求值变成运行器故障。
    """
    if resource is None:
        return 'resource limits unavailable (no resource module)'
    notes = []
    # RLIMIT_AS 是「整个进程的地址空间」上限，解释器自己已占的部分也算在内。若基础镜像太胖，
    # 直接把上限压到低于当前用量只会让第一条 import 就 MemoryError；这时宁可跳过并留下说明，
    # 由 docker 的 --memory 与 CPU 限制兜底。
    used_mb = _current_address_space_mb()
    if used_mb is not None and used_mb + ADDRESS_SPACE_HEADROOM_MB > memory_mb:
        notes.append(
            'RLIMIT_AS skipped (interpreter uses %.0fMB, limit %dMB)' % (used_mb, memory_mb)
        )
    else:
        try:
            limit = memory_mb * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
        except (ValueError, OSError) as exc:
            notes.append('RLIMIT_AS failed (%s)' % exc.__class__.__name__)
    try:
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 1))
    except (ValueError, OSError) as exc:
        notes.append('RLIMIT_CPU failed (%s)' % exc.__class__.__name__)
    try:
        resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
    except (ValueError, OSError) as exc:
        notes.append('RLIMIT_NOFILE failed (%s)' % exc.__class__.__name__)
    return '; '.join(notes) if notes else None


def main():
    request_id = ''
    try:
        job, failure = _read_job(sys.stdin)
        if failure is not None:
            _write_line(sys.stdout, _error_payload(request_id, failure))
            return 0
        request_id = job.get('requestId') if isinstance(job, dict) else ''
        memory_mb, cpu_seconds = _config_from_env()
        _drop_host_env()
        degraded = _apply_limits(memory_mb, cpu_seconds)
        if degraded is not None:
            # 诊断只走 stderr：服务端采集后丢弃，绝不进协议，也不回给客户端。
            try:
                sys.stderr.write('pwn2block-runner: %s\n' % degraded)
                sys.stderr.flush()
            except (OSError, ValueError, UnicodeEncodeError):
                # 诊断写不出去不影响求值；协议那一行才是契约。
                pass
        _write_line(sys.stdout, handle_job(job))
        return 0
    except BaseException:
        # 运行器自身故障也必须回一行协议错误，不能静默退出。
        request_id = request_id if isinstance(request_id, str) else ''
        _write_line(
            sys.stdout,
            _error_payload(request_id, {'code': 'bad_output', 'message': '运行器内部错误'}),
        )
        return 1


if __name__ == '__main__':
    sys.exit(main())
