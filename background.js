// background.js - ASU CreateAI API integration

const API_CONFIG = {
  baseUrl: 'https://api-main-poc.aiml.asu.edu/query',
  token: 'YOUR_BEARER_TOKEN_HERE' // Replace with your actual Bearer token
};

// Listen for messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getCourseData') {
    fetchCourseData(request.courseData).then(data => {
      sendResponse(data);
    });
    return true; // Keep message channel open for async response
  }
});

/**
 * Fetch course data (description and matches) from CreateAI API
 */
async function fetchCourseData(courseData) {
  try {
    // Get token from storage
    const storage = await chrome.storage.local.get({ createaiToken: '' });
    const token = storage.createaiToken;

    if (!token) {
      console.error('CreateAI API Error: No token found in storage.');
      return { success: false, error: 'API Token missing. Please set it in the extension options.' };
    }

    const institution = courseData.institution || '';
    const subject = courseData.subject || '';
    const number = courseData.number || '';
    const title = courseData.title || '';

    const query = `${institution} ${subject} ${number} ${title}`.trim();
    console.log('Fetching CreateAI data for query:', query);

    // ... rest of the payload and fetch logic stays same ...
    const payload = {
      "model_provider": "openai",
      "model_name": "gpt4o",
      "model_params": {
        "temperature": 0.1,
        "max_tokens": 2000,
        "system_prompt": "",
        "top_k": 3
      },
      "query": query,
      "enable_search": true,
      "search_params": {
        "db_type": "opensearch",
        "collection": "0cc3f744a8c740b0b36afb154d07ae24",
        "top_k": 3,
        "output_fields": ["content", "source_name", "page_number", "source_type", "chunk_number"]
      },
      "response_format": { "type": "json" }
    };

    const response = await fetch(API_CONFIG.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('CreateAI API error:', response.status, errorText);
      return { success: false, error: `API error: ${response.status}` };
    }

    const data = await response.json();
    console.log('CreateAI Raw Response:', data);

    // Parse the inner JSON string from the "response" field
    try {
      let responseText = data.response;

      // Remove markdown code blocks if present (e.g. ```json ... ```)
      responseText = responseText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

      const innerResponse = JSON.parse(responseText);

      // Map match_1, match_2, match_3 to an array
      const matches = [];
      if (innerResponse.matches) {
        Object.keys(innerResponse.matches).forEach(key => {
          const match = innerResponse.matches[key];
          matches.push({
            subject: match.subject,
            number: match.number,
            title: match.title,
            description: match.description,
            score: 100 // Default score since not provided in this format
          });
        });
      }

      return {
        success: true,
        description: innerResponse.input_course_description,
        matches: matches
      };
    } catch (parseError) {
      console.error('Error parsing inner JSON response:', parseError);
      return { success: false, error: 'Failed to parse API response' };
    }

  } catch (error) {
    console.error('Fetch error:', error);
    return { success: false, error: error.message };
  }
}

console.log('Triangulator extension background script (CreateAI) loaded');