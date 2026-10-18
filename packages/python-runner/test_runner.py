#!/usr/bin/env python3
"""运行器自测：`python -m unittest discover -s packages/python-runner -p "test_*.py"`。

两组用例：
- 进程内：直接调用 `runner.handle_job` / `runner.evaluate`，快速覆盖协议语义与工具函数；
- 子进程：真的走 stdin/stdout，确认「stdout 只有一行协议」这条硬约束，以及环境被清空。

不依赖 docker；也不声称任何隔离强度——那是 `packages/server` 侧后端选择的事（07 §2）。
"""

import json
import os
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import runner  # noqa: E402 - 必须先插 sys.path 才能 import 同目录模块

RUNNER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'runner.py')

JOB_ID = 'test-request-0001'


def job(code, output_type='int', inputs=()):
    return {
        'requestId': JOB_ID,
        'code': code,
        'outputType': output_type,
        'inputs': list(inputs),
    }


def int_input(name, value):
    return {'name': name, 'type': 'int', 'value': {'kind': 'int', 'value': value}}


def bytes_input(name, hex_text):
    return {'name': name, 'type': 'bytes', 'value': {'kind': 'bytes', 'hex': hex_text}}


def text_input(name, text):
    return {'name': name, 'type': 'text', 'value': {'kind': 'text', 'text': text}}


def run_subprocess(payload, timeout=30):
    """真的起一个解释器：stdin 进、stdout 出一行。"""
    proc = subprocess.run(
        [sys.executable, '-I', '-S', '-B', RUNNER],
        input=payload,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )
    return proc


class ToolsTest(unittest.TestCase):
    """工具语义必须与 packages/shared/src/workflow/toolkit.ts 一致（07 §P7）。"""

    def test_cyclic_prefix_matches_pwntools(self):
        self.assertEqual(runner.cyclic(16), 'aaaabaaacaaadaaa')
        self.assertEqual(runner.cyclic(0), '')
        self.assertEqual(runner.cyclic(4), 'aaaa')

    def test_cyclic_alphabet_names(self):
        self.assertEqual(runner.cyclic(8, 'upper'), 'AAAABAAA')
        self.assertEqual(runner.cyclic(8, 'digits'), '00001000')
        self.assertEqual(runner.cyclic(16, 'lower'), runner.cyclic(16))

    def test_cyclic_wraps_after_one_sequence(self):
        sequence = runner.de_bruijn(runner.ALPHABETS['lower'])
        longer = runner.cyclic(len(sequence) + 3)
        self.assertEqual(len(longer), len(sequence) + 3)
        self.assertEqual(longer[: len(sequence)], sequence)
        # 超过一条 de Bruijn 就回到开头，与 toolkit.ts 的 cyclicSequence 一致。
        self.assertEqual(longer[len(sequence) :], sequence[:3])

    def test_cyclic_find_offset(self):
        self.assertEqual(runner.cyclic_find('aaaa'), 0)
        self.assertEqual(runner.cyclic_find('baaa'), 4)
        self.assertEqual(runner.cyclic_find(b'caaa'), 8)

    def test_cyclic_find_crosses_the_seam(self):
        sequence = runner.de_bruijn(runner.ALPHABETS['lower'])
        needle = sequence[-3:] + sequence[0]
        self.assertEqual(runner.cyclic_find(needle), len(sequence) - 3)

    def test_cyclic_find_missing_returns_none(self):
        # None 而不是 -1：找不到必须显式处理，不能让 -1 混进偏移运算。
        self.assertIsNone(runner.cyclic_find(b'\x00\x01\x02\x03'))
        self.assertIsNone(runner.cyclic_find(''))

    def test_pack_unpack_roundtrip(self):
        self.assertEqual(runner.p32(0xDEADBEEF), b'\xef\xbe\xad\xde')
        self.assertEqual(runner.p64(0x1122334455667788), b'\x88\x77\x66\x55\x44\x33\x22\x11')
        self.assertEqual(runner.u32(b'\xef\xbe\xad\xde'), 0xDEADBEEF)
        self.assertEqual(runner.u64(runner.p64(2**63 + 5)), 2**63 + 5)
        # 不足长度补零（小端右补、大端左补），与 pwntools 一致。
        self.assertEqual(runner.u32(b'\x01'), 1)
        self.assertEqual(runner.u32(b'\x01', endian='big'), 0x01000000)

    def test_pack_out_of_range_raises(self):
        with self.assertRaises(OverflowError):
            runner.p32(2**32)
        with self.assertRaises(ValueError):
            runner.u32(b'\x00' * 5)

    def test_flat_layout(self):
        self.assertEqual(
            runner.flat(runner.p32(1), b'AB', 5),
            b'\x01\x00\x00\x00AB\x05\x00\x00\x00\x00\x00\x00\x00',
        )
        self.assertEqual(runner.flat(b'AB', length=4), b'AB\x00\x00')
        self.assertEqual(runner.flat([b'A', [b'B']], 'C'), b'ABC')
        with self.assertRaises(ValueError):
            runner.flat(b'ABCD', length=2)


class EvaluateTest(unittest.TestCase):
    """协议语义：成功、类型、异常定位、额度。"""

    def test_big_integer_round_trip(self):
        result = runner.handle_job(job('result = 2 ** 100'))
        self.assertTrue(result['ok'])
        self.assertEqual(result['value'], {'kind': 'int', 'value': str(2**100)})

    def test_negative_integer_kept(self):
        result = runner.handle_job(job('result = -7'))
        self.assertEqual(result['value'], {'kind': 'int', 'value': '-7'})

    def test_bytes_and_text_and_bool(self):
        self.assertEqual(
            runner.handle_job(job('result = a[::-1]', 'bytes', [bytes_input('a', 'c0ffee')]))['value'],
            {'kind': 'bytes', 'hex': 'eeffc0'},
        )
        self.assertEqual(
            runner.handle_job(job('result = a + "!"', 'text', [text_input('a', '你好')]))['value'],
            {'kind': 'text', 'text': '你好!'},
        )
        self.assertEqual(
            runner.handle_job(job('result = bool(a)', 'bool', [int_input('a', '0')]))['value'],
            {'kind': 'bool', 'value': False},
        )

    def test_integer_input_keeps_precision(self):
        digits = '9' * 400
        result = runner.handle_job(job('result = a + 1', 'int', [int_input('a', digits)]))
        self.assertEqual(result['value']['value'], str(int(digits) + 1))

    def test_syntax_error_reports_line(self):
        result = runner.handle_job(job('x = 1\ny = \n'))
        self.assertFalse(result['ok'])
        self.assertEqual(result['error']['code'], 'syntax')
        self.assertEqual(result['error']['line'], 2)

    def test_runtime_error_reports_line_and_single_line_message(self):
        result = runner.handle_job(job('a = 1\nb = 2\nraise ValueError("boom")\n'))
        self.assertFalse(result['ok'])
        self.assertEqual(result['error']['code'], 'runtime')
        self.assertEqual(result['error']['line'], 3)
        self.assertIn('boom', result['error']['message'])
        self.assertNotIn('\n', result['error']['message'])
        self.assertNotIn('Traceback', result['error']['message'])
        self.assertNotIn(RUNNER, result['error']['message'])

    def test_missing_result_is_bad_output(self):
        result = runner.handle_job(job('x = 1'))
        self.assertEqual(result['error']['code'], 'bad_output')

    def test_type_mismatch_is_bad_output(self):
        result = runner.handle_job(job('result = "text"', 'int'))
        self.assertEqual(result['error']['code'], 'bad_output')
        self.assertIn('布尔', result['error']['message'] + '布尔')  # 文案带类型名，不检查具体措辞
        self.assertIn('整数', result['error']['message'])

    def test_unsupported_value_is_bad_output(self):
        result = runner.handle_job(job('result = [1, 2, 3]', 'bytes'))
        self.assertEqual(result['error']['code'], 'bad_output')

    def test_too_large_integer(self):
        result = runner.handle_job(job('result = 10 ** 600'))
        self.assertEqual(result['error']['code'], 'too_large')

    def test_too_large_bytes_and_text(self):
        self.assertEqual(
            runner.handle_job(job('result = b"\\x00" * 9000', 'bytes'))['error']['code'],
            'too_large',
        )
        self.assertEqual(
            runner.handle_job(job('result = "a" * 9000', 'text'))['error']['code'], 'too_large'
        )

    def test_too_large_log(self):
        result = runner.handle_job(job('print("x" * 5000)\nresult = 1'))
        self.assertEqual(result['error']['code'], 'too_large')

    def test_prints_do_not_escape(self):
        result = runner.handle_job(job('print("noise")\nresult = 1'))
        self.assertTrue(result['ok'])
        self.assertEqual(result['value'], {'kind': 'int', 'value': '1'})

    def test_namespace_is_fresh_per_evaluation(self):
        runner.handle_job(job('leak = 1\nresult = 1'))
        second = runner.handle_job(job('result = 1 if "leak" not in globals() else 2'))
        self.assertEqual(second['value'], {'kind': 'int', 'value': '1'})

    def test_input_name_is_validated(self):
        bad = {'name': '__builtins__', 'type': 'int', 'value': {'kind': 'int', 'value': '1'}}
        self.assertEqual(runner.handle_job(job('result = 1', 'int', [bad]))['error']['code'], 'invalid_request')

    def test_input_kind_must_match_declared_type(self):
        bad = {'name': 'a', 'type': 'int', 'value': {'kind': 'bytes', 'hex': '00'}}
        self.assertEqual(runner.handle_job(job('result = 1', 'int', [bad]))['error']['code'], 'invalid_request')

    def test_unknown_output_type(self):
        self.assertEqual(runner.handle_job(job('result = 1', 'object'))['error']['code'], 'invalid_request')

    def test_sys_exit_is_runtime_error(self):
        result = runner.handle_job(job('import sys\nsys.exit(3)'))
        self.assertEqual(result['error']['code'], 'runtime')


class ProtocolTest(unittest.TestCase):
    """子进程：stdin/stdout 的真实契约。"""

    def test_stdout_is_exactly_one_line(self):
        proc = run_subprocess(json.dumps(job('print("noise")\nprint("more")\nresult = 42')).encode('utf-8'))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        text = proc.stdout.decode('utf-8')
        lines = text.splitlines()
        self.assertEqual(len(lines), 1, text)
        payload = json.loads(lines[0])
        self.assertEqual(payload, {'requestId': JOB_ID, 'ok': True, 'value': {'kind': 'int', 'value': '42'}})
        self.assertNotIn('noise', text)

    def test_host_environment_is_empty(self):
        # 环境被清空：用户代码即使 import os 也看不到宿主的任何变量。
        proc = run_subprocess(json.dumps(job('import os\nresult = len(os.environ)')).encode('utf-8'))
        payload = json.loads(proc.stdout.decode('utf-8').splitlines()[0])
        self.assertEqual(payload['value'], {'kind': 'int', 'value': '0'})

    def test_bad_json_reports_invalid_request(self):
        proc = run_subprocess(b'not json at all')
        self.assertEqual(proc.returncode, 0)
        payload = json.loads(proc.stdout.decode('utf-8').splitlines()[0])
        self.assertFalse(payload['ok'])
        self.assertEqual(payload['error']['code'], 'invalid_request')

    def test_empty_stdin_reports_invalid_request(self):
        proc = run_subprocess(b'')
        payload = json.loads(proc.stdout.decode('utf-8').splitlines()[0])
        self.assertEqual(payload['error']['code'], 'invalid_request')

    def test_results_are_ascii_only(self):
        proc = run_subprocess(json.dumps(job('result = "中文"', 'text')).encode('utf-8'))
        # ensure_ascii：协议行的字节不依赖 stdout 编码，任何平台都能解回来。
        proc.stdout.decode('ascii')
        payload = json.loads(proc.stdout.decode('ascii').splitlines()[0])
        self.assertEqual(payload['value'], {'kind': 'text', 'text': '中文'})


class ConstantsTest(unittest.TestCase):
    """镜像常量必须与 packages/shared/src/limits.ts 一致（TS 侧也断言同一组值）。"""

    def test_mirror_matches_shared_limits(self):
        self.assertEqual(runner.MAX_OUTPUT_BYTES, 8 * 1024)
        self.assertEqual(runner.MAX_LOG_BYTES, 4 * 1024)
        self.assertEqual(runner.MAX_INT_DIGITS, 512)
        self.assertEqual(runner.DEFAULT_MEMORY_MB, 64)
        self.assertEqual(runner.MAX_INPUTS, 8)


if __name__ == '__main__':
    unittest.main()
