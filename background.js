// background.js - ASU CreateAI API integration

const API_CONFIG = {
  baseUrl: 'https://api-main-poc.aiml.asu.edu/query',
  token: '' // Note: Bearer token is retrieved from chrome.storage.local at runtime; do not hardcode tokens here.
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
 * Calculate similarity between two strings (0 to 1)
 */
function calculateSimilarity(s1, s2) {
  if (!s1 || !s2) return 0;
  s1 = s1.toLowerCase().trim();
  s2 = s2.toLowerCase().trim();

  if (s1 === s2) return 1.0;

  // Simple Jaro-Winkler or Levenshtein would be better, but for course codes
  // we can use a basic overlap + length penalty or similar.
  // Let's use a basic character-based similarity for now.
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;
  const longerLength = longer.length;
  if (longerLength === 0) return 1.0;

  const distance = editDistance(s1, s2);
  return (longerLength - distance) / parseFloat(longerLength);
}

function editDistance(s1, s2) {
  const costs = [];
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i === 0)
        costs[j] = j;
      else {
        if (j > 0) {
          let newValue = costs[j - 1];
          if (s1.charAt(i - 1) !== s2.charAt(j - 1))
            newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
          costs[j - 1] = lastValue;
          lastValue = newValue;
        }
      }
    }
    if (i > 0) costs[s2.length] = lastValue;
  }
  return costs[s2.length];
}

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
      const description = innerResponse.input_course_description;
      const reflectedSubject = innerResponse.subject || '';
      const reflectedNumber = innerResponse.number || '';

      // Classification Logic
      let matchType = 'no_match';
      let similarity = 0;

      const lowerDesc = (description || '').toLowerCase();

      // Catalog level failure (Institution not indexed)
      const isMissingCatalog = !description ||
        lowerDesc.includes('institution not found') ||
        lowerDesc.includes('catalog not found') ||
        lowerDesc.includes('not indexed');

      // Course level failure (Course not found in an existing catalog)
      const isMissingCourse = lowerDesc.includes('cannot find') ||
        description.length < 5;

      const hasReflectedCourse = reflectedSubject && reflectedNumber;

      if (isMissingCatalog) {
        matchType = 'catalog_not_found';
      } else if (isMissingCourse && !hasReflectedCourse) {
        // If we have no course data and a "not found" message, it's a no_match
        matchType = 'no_match';
      } else {
        // If we HAVE a reflected course (even if desc is "missing"), check similarity
        const reqCourse = `${courseData.subject} ${courseData.number}`.toLowerCase().trim();
        const refCourse = `${reflectedSubject} ${reflectedNumber}`.toLowerCase().trim();

        similarity = calculateSimilarity(reqCourse, refCourse);

        if (similarity === 1.0) {
          matchType = 'exact';
        } else if (similarity >= 0.7) {
          matchType = 'fuzzy';
        } else {
          matchType = 'no_match';
        }
      }

      console.log(`Classification: ${matchType} (Similarity: ${similarity.toFixed(2)})`);

      const matches = [];
      if (matchType !== 'catalog_not_found' && innerResponse.matches) {
        Object.keys(innerResponse.matches).forEach(key => {
          const match = innerResponse.matches[key];

          // Also validate that match has subject and number
          if (match.subject && match.number) {
            // Normalize number: Remove .0 hallucination (e.g., 216.0 -> 216)
            let cleanNumber = String(match.number);
            if (cleanNumber.endsWith('.0')) {
              cleanNumber = cleanNumber.slice(0, -2);
            }

            matches.push({
              subject: match.subject,
              number: cleanNumber,
              title: match.title,
              description: match.description
            });
          }
        });
      }

      return {
        success: true,
        match_type: matchType,
        similarity: similarity,
        reflected_course: {
          subject: reflectedSubject,
          number: reflectedNumber
        },
        description: description || 'Course description not available in catalog.',
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