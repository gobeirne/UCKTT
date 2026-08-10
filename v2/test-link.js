/* Focused test for the connection-state machine extracted from pairedMode.js.
   The real module needs RapidPair, Firebase and a DOM to load, so the logic
   under test is mirrored here exactly as written and driven directly. What is
   being verified is the *shape* of the guard, which is where the bug was. */

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  PASS', n); }
                          else { fail++; console.log('  FAIL', n, e === undefined ? '' : '→ ' + e); } };

function makeMachine(useOldGuard) {
  const m = {
    pairSecure: false, connectSeq: 0, downSince: null, sendFailures: 0,
    disconnectTimer: null, log: [],
  };
  m.onSecure = () => {
    m.pairSecure = true; m.connectSeq++; m.sendFailures = 0; m.downSince = null;
    m.log.push('SECURE');
  };
  m.onDisconnected = () => {
    const seq = m.connectSeq;
    clearTimeout(m.disconnectTimer);
    m.disconnectTimer = setTimeout(() => {
      if (useOldGuard) { if (m.pairSecure) return; }      // the original bug
      else             { if (m.connectSeq !== seq) return; }
      m.pairSecure = false;
      if (!m.downSince) m.downSince = Date.now();
      m.sendFailures = 0;
      m.log.push('DISCONNECTED');
    }, 5);
  };
  m.safeSend = (channelOpen) => {
    if (!m.pairSecure) return false;
    if (channelOpen) { m.sendFailures = 0; return true; }
    m.sendFailures++;
    if (m.sendFailures >= 3) m.onDisconnected();
    return false;
  };
  return m;
}

const settle = () => new Promise(r => setTimeout(r, 20));

(async () => {
  console.log('\n1. The original guard never clears pairSecure');
  {
    const m = makeMachine(true);
    m.onSecure();
    m.onDisconnected();
    await settle();
    ok('reproduces the field bug: still "connected"', m.pairSecure === true);
    ok('and never logged DISCONNECTED', !m.log.includes('DISCONNECTED'));
  }

  console.log('\n2. The sequence guard clears it');
  {
    const m = makeMachine(false);
    m.onSecure();
    m.onDisconnected();
    await settle();
    ok('pairSecure cleared', m.pairSecure === false);
    ok('DISCONNECTED logged', m.log.includes('DISCONNECTED'));
    ok('downSince recorded', typeof m.downSince === 'number');
  }

  console.log('\n3. A real reconnect still suppresses the pending disconnect');
  {
    const m = makeMachine(false);
    m.onSecure();
    m.onDisconnected();      // drop
    m.onSecure();            // reconnects before the debounce expires
    await settle();
    ok('stays connected', m.pairSecure === true);
    ok('no spurious DISCONNECTED', !m.log.includes('DISCONNECTED'));
    ok('downSince cleared', m.downSince === null);
  }

  console.log('\n4. Repeated ICE churn only reports once');
  {
    const m = makeMachine(false);
    m.onSecure();
    for (let i = 0; i < 6; i++) m.onDisconnected();
    await settle();
    ok('exactly one DISCONNECTED',
       m.log.filter(x => x === 'DISCONNECTED').length === 1,
       m.log.filter(x => x === 'DISCONNECTED').length);
  }

  console.log('\n5. Failed sends declare the link dead');
  {
    const m = makeMachine(false);
    m.onSecure();
    ok('1st failure does not trip', m.safeSend(false) === false && m.pairSecure === true);
    m.safeSend(false);
    m.safeSend(false);       // third consecutive → onDisconnected
    await settle();
    ok('three consecutive failures disconnect', m.pairSecure === false);
  }

  console.log('\n6. A success resets the failure count');
  {
    const m = makeMachine(false);
    m.onSecure();
    m.safeSend(false); m.safeSend(false);
    m.safeSend(true);                       // recovered
    m.safeSend(false); m.safeSend(false);
    await settle();
    ok('not disconnected by non-consecutive failures', m.pairSecure === true,
       'failures=' + m.sendFailures);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
