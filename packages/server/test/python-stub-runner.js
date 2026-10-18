#!/usr/bin/env node
/**
 * 桩运行器（只给服务端测试用）。
 *
 * 它只实现「一行 JSON 协议」的外壳，按 argv[2] 的剧本行事，用来在测试里驱动求值器**真实的**
 * 子进程、超时、取消、输出上限与协议校验——被测逻辑（排队、kill、解析、类型校验）一行都不
 * 替换。真正的 Python 语义由 packages/python-runner/test_runner.py 覆盖。
 *
 * 用法：node python-stub-runner.js <scenario>
 */

const scenario = process.argv[2] ?? 'success';

const write = (payload) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

/** 按声明的输出类型回一个能被断言的值；int 用代码长度，证明任务确实经 stdin 送到了。 */
const echo = (job) => {
  switch (job.outputType) {
    case 'int':
      return { kind: 'int', value: String(job.code.length) };
    case 'bytes':
      return { kind: 'bytes', hex: Buffer.from(job.code, 'utf8').toString('hex') };
    case 'text':
      return { kind: 'text', text: job.code };
    default:
      return { kind: 'bool', value: true };
  }
};

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const job = JSON.parse(input);
  const ok = (value) => write({ requestId: job.requestId, ok: true, value });

  switch (scenario) {
    case 'success':
      ok(echo(job));
      return;
    case 'wrong-type':
      // 声明 int 却回 bytes：服务端必须自己再校验一次（07 §P6「严格检查返回类型」）。
      ok({ kind: 'bytes', hex: 'c0ffee' });
      return;
    case 'late':
      write({ requestId: 'some-other-job', ok: true, value: { kind: 'int', value: '999' } });
      return;
    case 'error':
      write({
        requestId: job.requestId,
        ok: false,
        error: { code: 'runtime', message: '桩运行器报告运行错误', line: 2 },
      });
      return;
    case 'bad-json':
      process.stdout.write('not json at all\n');
      return;
    case 'two-lines':
      ok({ kind: 'int', value: '1' });
      ok({ kind: 'int', value: '2' });
      return;
    case 'silent':
      return;
    case 'crash':
      process.exit(3);
      return;
    case 'oversize':
      ok({ kind: 'bytes', hex: '00'.repeat(9000) });
      return;
    case 'flood':
      process.stdout.write('x'.repeat(200_000));
      return;
    case 'sleep':
      // 永远不回复：超时与取消用例靠它验证「真的杀掉了」。
      setInterval(() => undefined, 60_000);
      return;
    default:
      process.stdout.write(`unknown scenario: ${scenario}\n`);
      process.exit(2);
  }
});
