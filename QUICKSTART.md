# Triangulator Extension - Quick Start Guide

## 🚀 Installation & Testing (5 minutes)

### Step 1: Load the Extension
1. Open Chrome browser
2. Go to `chrome://extensions/`
3. Turn on **Developer mode** (toggle in top-right corner)
4. Click **Load unpacked**
5. Navigate to and select the `triangulator-extension` folder
6. You should see "Triangulator Course Matcher" appear in your extensions

### Step 2: Test the Extension
1. Open `test.html` in Chrome (File > Open File)
2. Click on any course row in the table
3. A popup should slide in from the right side with course details

### Step 3: Test Different States
- **TKISH 102**: Course with description, no matches
- **JPN 203**: Course with description and 2 equivalent matches (try the carousel!)
- **LING 240**: No data available state
- **Other courses**: Will show no data available

## 🎯 Expected Behavior

### When you click a course:
1. ✅ Popup slides in from the right
2. ✅ Shows institution and course details
3. ✅ Shows course description (if available)
4. ✅ Shows equivalent courses with match scores (if available)
5. ✅ Can navigate through matches using arrow button
6. ✅ Can collapse/expand popup using logo button

### Popup Features:
- **Collapse Button**: Click the logo icon to minimize the popup
- **Carousel Navigation**: Use the → button to cycle through matches
- **Match Scores**: Visual pie chart showing match percentage
- **Close**: Press ESC key or click outside

## 🔧 Troubleshooting

### Extension not working?
1. Check Chrome extensions page: `chrome://extensions/`
2. Make sure extension is **enabled** (toggle on)
3. Check for errors: Click "Errors" button if present
4. Try reloading: Click the refresh icon on the extension card

### Popup not appearing?
1. Open browser console: F12 or Cmd+Option+J (Mac)
2. Check for JavaScript errors
3. Make sure you're clicking inside a table row
4. Verify you're on the test.html page

### Testing with real TCG:
1. Once you have access to TCG QA/DEV environment
2. The extension should work automatically on TCG pages
3. Click any course row to trigger the popup

## 📝 Development Workflow

### Making Changes:
1. Edit files in `triangulator-extension/` folder
2. Go to `chrome://extensions/`
3. Click the **refresh icon** on the extension card
4. Reload your test page to see changes

### Key Files:
- `content.js` - Detects clicks and shows popup
- `content.css` - Popup styling
- `background.js` - API calls (currently using mock data)
- `manifest.json` - Extension configuration

## 🔗 Next Steps

### When API is Ready:
1. Open `background.js`
2. Update `API_CONFIG.baseUrl` with real API URL
3. Uncomment the fetch code in `fetchCourseMatches()`
4. Test with real data

### For Production:
1. Test thoroughly in TCG environment
2. Update version in `manifest.json`
3. Add proper error handling
4. Add loading states
5. Consider publishing to Chrome Web Store

## 💡 Tips

- **Console Logs**: Check browser console for debug info
- **Inspect Element**: Right-click popup > Inspect to debug styles
- **Mock Data**: Edit `MOCK_DATA` in `background.js` to test different scenarios
- **Keyboard**: Press ESC to close popup

## 📞 Need Help?

Contact:
- Truman Hale (Design/Product)
- Faraj (Development)

---

**Current Version**: 1.0.0  
**Status**: Development/Testing with Mock Data  
**Next Milestone**: API Integration
