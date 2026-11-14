;; The module the tests run against. Build the fixture with:
;; wat2wasm src/fixture/test-module.wat -o - | base64 > src/fixture/test-module.b64
(module
  (memory (export "memory") 1)
  (global $next (mut i32) (i32.const 8))
  ;; bump allocator, 8 byte aligned, grows the memory when needed
  (func (export "alloc") (param $length i32) (result i32)
    (local $pointer i32) (local $end i32)
    (local.set $pointer (global.get $next))
    (local.set $end (i32.and (i32.add (i32.add (local.get $pointer) (local.get $length)) (i32.const 7)) (i32.const -8)))
    (if (i32.gt_u (local.get $end) (i32.mul (memory.size) (i32.const 65536)))
      (then (drop (memory.grow (i32.add (i32.shr_u (i32.sub (local.get $end) (i32.mul (memory.size) (i32.const 65536))) (i32.const 16)) (i32.const 1))))))
    (global.set $next (local.get $end))
    (local.get $pointer))
  ;; writes the input reversed
  (func (export "reverse") (param $input i32) (param $length i32) (param $output i32) (param $capacity i32) (result i32)
    (local $index i32)
    (if (i32.gt_u (local.get $length) (local.get $capacity)) (then (return (i32.const -2))))
    (block $done
      (loop $copy
        (br_if $done (i32.ge_u (local.get $index) (local.get $length)))
        (i32.store8
          (i32.add (local.get $output) (local.get $index))
          (i32.load8_u (i32.sub (i32.add (local.get $input) (i32.sub (local.get $length) (i32.const 1))) (local.get $index))))
        (local.set $index (i32.add (local.get $index) (i32.const 1)))
        (br $copy)))
    (local.get $length))
  ;; claims to have written more than it may
  (func (export "overflow") (param i32 i32 i32) (param $capacity i32) (result i32)
    (i32.add (local.get $capacity) (i32.const 1)))
  (func (export "fail") (param i32 i32 i32 i32) (result i32)
    (i32.const -1))
  (func (export "trap") (param i32 i32 i32 i32) (result i32)
    unreachable)
  ;; counts how often it was called since instantiation, so a re-instantiation is visible
  (global $calls (mut i32) (i32.const 0))
  (func (export "count") (param i32 i32) (param $output i32) (param i32) (result i32)
    (global.set $calls (i32.add (global.get $calls) (i32.const 1)))
    (i32.store (local.get $output) (global.get $calls))
    (i32.const 4)))
