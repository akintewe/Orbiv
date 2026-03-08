const btn = document.getElementById('btn-allow');
const status = document.getElementById('status');

btn.addEventListener('click', async () => {
  status.textContent = 'Requesting access...';
  status.className = 'status';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    status.textContent = 'Microphone enabled! You can close this tab and use voice commands in Orbiv.';
    status.className = 'status success';
    btn.textContent = 'Done!';
    btn.disabled = true;
    chrome.runtime.sendMessage({ type: 'mic-permission-granted' });
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      status.textContent = 'Permission denied. Click the button again and choose "Allow" in the popup.';
    } else {
      status.textContent = 'Error: ' + err.message;
    }
    status.className = 'status error';
  }
});
