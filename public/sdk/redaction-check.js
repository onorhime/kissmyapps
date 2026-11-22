const result = document.getElementById('result')
const button = document.getElementById('run')
const fixtures = {
  input: 'Synthetic input 18273',
  mask: 'Synthetic masked text 29481',
  block: 'Synthetic blocked text 32514',
  visible: 'Visible snapshot marker 48301',
}
document.getElementById('example-input').value = fixtures.input
for (const name of ['mask', 'block', 'visible']) {
  document.getElementById('example-' + name).textContent = fixtures[name]
}
button.addEventListener('click', () => {
  let recording
  let snapshot
  try {
    recording = window.__kmaReplay.start((event) => {
      if (event.type === 2) snapshot = JSON.stringify(event.data)
    })
    recording.takeFullSnapshot()
    const captured = snapshot && snapshot.includes(fixtures.visible)
    const masked =
      captured &&
      [fixtures.input, fixtures.mask, fixtures.block].every((value) => !snapshot.includes(value))
    result.textContent = masked
      ? 'Passed. The snapshot contains the visible marker and hides all three private values.'
      : captured
        ? 'Check failed. A sample private value was visible in the snapshot.'
        : 'No snapshot received. Reload and try again.'
  } catch {
    result.textContent = 'The recorder could not start. Reload and try again.'
  } finally {
    recording?.stop()
  }
})
