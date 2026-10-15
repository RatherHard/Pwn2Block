/* global window */
/* 仅为公开合成展示样例；不加载题库、私有包、环境变量或参考解法。
 * 地址/可见标签沿用 web/src/fixtures/sample.ts 的教学布局。
 * 下面每个 frame 都是手写展示快照；按钮只选择快照，不执行 VM。
 */
window.P2B_DEMO = Object.freeze({
  challenge: {
    id: 'design-stack-lab', title: '栈上的第一步', archBits: 64,
    allowedActions: ['write_bytes', 'push', 'pop', 'call', 'ret', 'step', 'run'],
    authorBlocks: [{ id: 'fill_buffer', label: '填充缓冲区', params: [{name:'bytes',type:'bytes'}], tooltip: '公开声明的教学积木：将给定字节写入 buffer。' }],
    hints: [
      {text:'先观察 buffer、saved_bp 与 ret_addr 的相邻位置；每一行是 8 字节。'},
      {text:'用地址相减计算偏移。小端序下，低位字节放在较低地址。',unlockAfterFailures:2},
      {text:'把调试中得到的字面量写进积木，提交会从初始状态重新执行。',unlockAfterFailures:4}
    ]
  },
  // 仅供原型：生产 roles 来源是契约缺口，不是按名字猜测的约定。
  // I/O 场景使用的公开声明变体；仍是展示模型，不是完整题包。
  ioDeclaration: {
    allowedActions: ['write_bytes','push','pop','call','ret','step','run','feed'],
    syscallAbi: {nr:'RAX',args:['RDI','RSI','RDX'],ret:'RAX'},
    syscalls: [{nr:0,name:'read',kind:'read',doc:'从虚拟 fd 读取字节'},{nr:1,name:'write',kind:'write',doc:'向 stdout 写入字节'}],
    fds: [{fd:0,name:'stdin',kind:'stdin'},{fd:1,name:'stdout',kind:'stdout'}]
  },
  roles: {sp:'RSP',bp:'RBP',ip:'RIP'},
  disasm: [
    {addr:'0x400000',bytes:'c9',text:'leave',comment:'恢复栈帧'},
    {addr:'0x400001',bytes:'c3',text:'ret',comment:'弹出返回地址 → ip'},
    {addr:'0x400002',bytes:'0f',text:'syscall win',comment:'公开伪汇编'},
    {addr:'0x400003',bytes:'0e',text:'syscall exit',comment:'退出程序'},
    {addr:'0x400004',bytes:'e9 00 00 40 00 00 00 00 00',text:'jmp',target:'0x400000',comment:'跳转目标可点击'}
  ],
  functions: [{name:'entry',addr:'0x400000'},{name:'win',addr:'0x400002'},{name:'exit',addr:'0x400003'}],
  vmas: [
    {id:'text',kind:'code',label:'程序代码',start:'0x400000',end:'0x401000',perm:'rx',hidden:false},
    {id:'stack',kind:'stack',label:'调用栈',start:'0x7fffe000',end:'0x80000000',perm:'rw',hidden:false},
    {id:'key',kind:'key',label:'密钥区',start:'0x80000000',end:'0x80001000',perm:'rw',hidden:true}
  ],
  frames: [
    {label:'初始状态',steps:0,sp:'0x7fffff00',bp:'0x7fffff10',ip:'0x400000',buffer:'00',ret:'03',stdout:'',stdinPos:0},
    {label:'动作 1 · write_bytes',steps:0,sp:'0x7fffff00',bp:'0x7fffff10',ip:'0x400000',buffer:'41',ret:'03',stdout:'',stdinPos:0},
    {label:'动作 2 · write_bytes',steps:0,sp:'0x7fffff00',bp:'0x7fffff10',ip:'0x400000',buffer:'41',ret:'02',stdout:'',stdinPos:0},
    {label:'动作 3 · run',steps:2,sp:'0x7fffff20',bp:'0x7fffff40',ip:'0x400002',buffer:'41',ret:'02',stdout:'ready\n',stdinPos:4},
    {label:'调试回退样例 · leave 后',steps:1,sp:'0x7fffff18',bp:'0x7fffff40',ip:'0x400001',buffer:'41',ret:'02',stdout:'',stdinPos:0}
  ],
  programs: {
    16: [
      {type:'write_bytes',addr:'0x7fffff00',hex:'41414141414141414141414141414141',blockId:'block-write'},
      {type:'write_bytes',addr:'0x7fffff18',hex:'0200400000000000',blockId:'block-address'},
      {type:'run',blockId:'block-run'}
    ],
    24: [
      {type:'write_bytes',addr:'0x7fffff00',hex:'4141414141414141414141414141414141414141414141414141',blockId:'block-write'},
      {type:'write_bytes',addr:'0x7fffff18',hex:'0200400000000000',blockId:'block-address'},
      {type:'run',blockId:'block-run'}
    ]
  },
  verdicts: {
    won:{title:'判题通过',symbol:'✓',tone:'success',detail:'独立判题实例已从初始状态执行完整 payload。',frame:3},
    incomplete:{title:'还差一步',symbol:'◇',tone:'warning',detail:'payload 跑完了，但没有达成目标。回看动作顺序，继续补全你的思路。',frame:3},
    failed:{title:'运行失败',symbol:'!',tone:'error',detail:'指令执行发生异常。已定位到出错的动作帧。',frame:3},
    rejected:{title:'动作被拒绝',symbol:'×',tone:'error',detail:'动作 2 被拒绝：目标位于隐藏 VMA。该动作未生效。',frame:2}
  },
  scenarios: [
    ['default','默认调试工作台'],['io','I/O 与隐藏内存'],['registers','寄存器与指针链'],
    ['uncompiled','尚未编译'],['stale','编译产物过期'],['error','编译错误与定位'],['limit','编译上限错误'],
    ['waiting','请求等待'],['complete','动作已执行完'],['satisfied','调试满足条件'],
    ['won','判题 · 通过'],['incomplete','判题 · 未完成'],['failed','判题 · 失败'],['rejected','判题 · 拒绝'],
    ['debug-failed','调试异常'],['exited','调试已退出'],['expired','会话失效'],['network','网络错误'],
    ['loading','加载中'],['no-challenges','暂无可用题目'],['empty','空工作区'],['history','回退窗口已用尽'],['hints','自动揭示提示'],['long','长文本与大量动作']
  ]
});
