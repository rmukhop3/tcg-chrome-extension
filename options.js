// options.js - Save/Load extension settings

function saveOptions() {
    const token = document.getElementById('token').value;
    chrome.storage.local.set({
        createaiToken: token
    }, () => {
        const status = document.getElementById('status');
        status.style.display = 'block';
        setTimeout(() => {
            status.style.display = 'none';
        }, 2000);
    });
}

function restoreOptions() {
    chrome.storage.local.get({
        createaiToken: ''
    }, (items) => {
        document.getElementById('token').value = items.createaiToken;
    });
}

document.addEventListener('DOMContentLoaded', restoreOptions);
document.getElementById('save').addEventListener('click', saveOptions);
