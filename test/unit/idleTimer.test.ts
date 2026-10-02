import * as assert from 'node:assert/strict';
import { IdleTimer } from '../../src/idleTimer';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

suite('IdleTimer', () => {
  test('fires once when not restarted in time', async () => {
    let calls = 0;
    const timer = new IdleTimer(20, () => calls++);
    await sleep(60);
    assert.equal(calls, 1);
    assert.ok(timer.fired);
    timer.dispose();
  });

  test('each restart pushes the deadline back', async () => {
    let calls = 0;
    const timer = new IdleTimer(40, () => calls++);
    for (let i = 0; i < 4; i++) {
      await sleep(20);
      timer.restart();
    }
    assert.equal(calls, 0);
    assert.ok(!timer.fired);
    timer.dispose();
  });

  test('never fires after dispose', async () => {
    let calls = 0;
    const timer = new IdleTimer(20, () => calls++);
    timer.dispose();
    await sleep(60);
    assert.equal(calls, 0);
  });

  test('a restart after firing does not start it again', async () => {
    let calls = 0;
    const timer = new IdleTimer(20, () => calls++);
    await sleep(40);
    timer.restart();
    await sleep(40);
    assert.equal(calls, 1);
    timer.dispose();
  });
});
