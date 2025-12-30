# Triangulator Chrome Extension

A Chrome extension that helps users find course equivalencies across institutions by detecting course data in the TCG (Transfer Course Guide) interface.

## Project Structure

```
triangulator-extension/
├── manifest.json          # Extension configuration
├── content.js             # Content script (detects course clicks)
├── content.css            # Styles for the popup
├── background.js          # Background service worker (API calls)
├── popup.html             # Extension popup UI
├── triangulator_logo.png  # Logo image
├── backgrounddotpattern.jpg # Background pattern
├── icons/                 # Extension icons
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── test.html             # Test page for development
```

## How It Works

1. **Detection**: When a user clicks on a course row in the TCG interface, the content script (`content.js`) extracts the course data from the HTML
2. **Data Extraction**: The extension looks for specific HTML patterns:
   - Institution name from `.institutionText a`
   - Subject from `[class*="subject_"]`
   - Course number from `[class*="number_"]`
   - Title from `[class*="title_"]`
   - Credit hours from `[class*="hours_"]`
3. **API Call**: The background script (`background.js`) sends the course data to the API (currently using mock data)
4. **Display**: A popup appears on the right side of the screen showing:
   - Course details
   - Course description
   - Equivalent courses with match percentages (if available)

## Installation

### For Development

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the `triangulator-extension` folder
5. The extension should now appear in your extensions list

### Testing

1. Open the included `test.html` file in Chrome
2. Click on any course row
3. The Triangulator popup should appear on the right side

## Current Status

### ✅ Implemented
- Chrome extension structure
- Course data detection from HTML
- Popup UI with course information
- Carousel for multiple course matches
- Match score visualization
- Collapsible popup

### 🔄 In Progress
- API integration (currently using mock data)
- Access to S3 bucket for course data

### 📋 To Do
- Connect to actual API endpoint when ready
- Add authentication if needed
- Test with real TCG interface
- Add error handling and loading states
- Add settings/options page
- Optimize performance

## Mock Data

The extension currently uses mock data in `background.js`:
- `TKISH 102`: No matches
- `JPN 203`: Two matches with 80% and 65% scores

## API Integration

When the API is ready, update `background.js`:

1. Change `API_CONFIG.baseUrl` to the actual API URL
2. Uncomment the fetch code in `fetchCourseMatches()`
3. Remove or comment out the mock data

Expected API request format:
```json
{
  "institution": "University of Washington",
  "subject": "TKISH",
  "number": "102",
  "title": "ELEMENTARY TURKISH",
  "hours": "5",
  "sourceId": "003798"
}
```

Expected API response format:
```json
{
  "success": true,
  "description": "Course description text...",
  "matches": [
    {
      "title": "Course Title",
      "subject": "SUBJ",
      "number": "101",
      "hours": "4",
      "score": 80,
      "description": "Match description..."
    }
  ]
}
```

## Development Notes

### HTML Pattern to Detect

The extension looks for this HTML structure in the TCG interface:
```html
<tr>
  <td>
    <span class="institutionText">
      <a href="/app/tca?sourceId=003798">UNIVERSITY OF WASHINGTON</a>
    </span>
  </td>
  <td>
    <span class="admin_change_field subject_1597601">TKISH</span>
  </td>
  <td>
    <span class="admin_change_field number_1597601">102</span>
  </td>
  <td>
    <span class="admin_change_field title_1597601">ELEMENTARY TURKISH</span>
  </td>
  <td>
    <span class="admin_change_field hours_1597601">5</span>
  </td>
</tr>
```

### Customization

To customize the appearance:
- Edit `content.css` for styling
- Edit `popup.html` for the standalone popup
- Colors are defined as CSS variables in `:root`

## Team

- Truman Hale (Design & Concept)
- Faraj (Development)

## Next Steps

1. Get access to QA/DEV TCG environment for testing
2. Integrate with CreateAI API once ready
3. Test with real course data from S3
4. Refine UI/UX based on testing
5. Add more features as needed
