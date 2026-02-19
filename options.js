// options.js - Save/Load extension settings

function saveOptions() {
    const token = document.getElementById('token').value;
    const environment = document.getElementById('environment').value;
    const showAsuMatches = document.getElementById('showAsuMatches').checked;
    
    chrome.storage.local.set({
        createaiToken: token,
        environment: environment,
        showAsuMatches: showAsuMatches
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
        createaiToken: '',
        environment: 'poc',  // Default to POC
        showAsuMatches: false  // Default to hiding ASU matches
    }, (items) => {
        document.getElementById('token').value = items.createaiToken;
        document.getElementById('environment').value = items.environment;
        document.getElementById('showAsuMatches').checked = items.showAsuMatches;
    });
}

document.addEventListener('DOMContentLoaded', restoreOptions);
document.getElementById('save').addEventListener('click', saveOptions);
