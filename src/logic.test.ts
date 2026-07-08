import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampSize, dockSize } from './logic'

test('clampSize clamps to [min, 60% of container]', () => {
  assert.equal(clampSize(50, 2000, 200), 200)
  assert.equal(clampSize(5000, 1000, 200), 600)
  assert.equal(clampSize(340, 2000, 200), 340)
})
test('clampSize honors a custom min', () => {
  assert.equal(clampSize(50, 2000, 120), 120)
  assert.equal(clampSize(300, 2000, 120), 300)
})
const rect = { left: 100, right: 1100, width: 1000 }
test('dockSize left = pointer minus left edge', () => {
  assert.equal(dockSize('left', rect, 440), 340)  // 440-100
})
test('dockSize right = right edge minus pointer', () => {
  assert.equal(dockSize('right', rect, 760), 340)  // 1100-760
})
