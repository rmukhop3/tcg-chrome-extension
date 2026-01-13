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
 * Validate institution name match with abbreviation handling
 * e.g. "AGRICULTURAL" matches "AG", "COLLEGE" matches "COLL"
 */
function validateInstitution(requested, reflected) {
  if (!requested || !reflected) return false;

  const normalize = (str) => str.toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const req = normalize(requested);
  const ref = normalize(reflected);

  // 1. Direct match
  if (req === ref) return true;

  // 2. Word overlapping with abbreviation check
  const reqWords = req.split(' ');
  const refWords = ref.split(' ');

  // Common abbreviations map
  const abbreviations = {
    'university': 'univ',
    'college': 'coll',
    'agricultural': 'ag',
    'technical': 'tech',
    'technology': 'tech',
    'institute': 'inst',
    'community': 'comm',
    'state': 'st',
    'north': 'n',
    'south': 's',
    'east': 'e',
    'west': 'w',
    'district': 'dist'
  };

  let matchCount = 0;

  // Check if enough words from the requested institution appear in the reflected one
  for (const w1 of reqWords) {
    if (w1.length <= 2 && !abbreviations[w1]) continue; // Skip small words like "of", "the" unless mapped

    for (const w2 of refWords) {
      if (w1 === w2) {
        matchCount++;
        break;
      }

      // Check abbreviations both ways
      const abbr1 = abbreviations[w1];
      const abbr2 = abbreviations[w2];

      if ((abbr1 && abbr1 === w2) || (abbr2 && abbr2 === w1)) {
        matchCount++;
        break;
      }

      // Check simple prefix match if word is long enough
      if (w1.length > 4 && w2.length > 4) {
        if (w1.startsWith(w2) || w2.startsWith(w1)) {
          matchCount++;
          break;
        }
      }
    }
  }

  // If we matched more than 50% of the significant words, consider it valid
  const significantReqWords = reqWords.filter(w => w.length > 2).length;
  // Guard against division by zero
  if (significantReqWords === 0) return true;

  return (matchCount / significantReqWords) >= 0.5;
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
        "system_prompt": "You are a helpful assistant who validates course details. You will be provided with a course (Subject, Number, Title) and an Institution.\n\n### 1. Catalog Search\nFirst, determine if the Institution's course catalog is available in your knowledge base.\n- If the catalog is NOT found or the institution is unrecognized: Set \"catalog_status\" to \"not_indexed\".\n- If the catalog is found: Set \"catalog_status\" to \"found\" and provide the \"reflected_institution\" name as found in your knowledge base.\n\n### 2. Course Validation\nIf the catalog is found, search for the specific course.\n- If the exact or a highly similar course (e.g., matching a lab or lecture version like BIOL 2251 to 2251L) is found: Provide the \"subject\", \"number\", \"title\", and \"input_course_description\" from the catalog.\n- If no related course is found: Set \"input_course_description\" to \"Cannot find the course description\".\n\n### 3. Equivalent Matches\nProvide exactly 3 matches from ASU for the input course.\n\n### Output Format\nAlways respond in the following JSON format:\n{\n\"catalog_status\": \"found\" | \"not_indexed\",\n\"reflected_institution\": \"Full Institution Name found in catalog\",\n\"subject\": \"The Subject found (e.g. PSY)\",\n\"number\": \"The Number found (e.g. 101, should be an int and not float)\",\n\"title\": \"The Course Title found\",\n\"input_course_description\": \"Direct catalog text OR 'Cannot find the course description'\",\n\"matches\": {\n\"match_1\": { \"subject\": \"\", \"number\": \"\", \"title\": \"\", \"description\": \"\" },\n\"match_2\": { \"subject\": \"\", \"number\": \"\", \"title\": \"\", \"description\": \"\" },\n\"match_3\": { \"subject\": \"\", \"number\": \"\", \"title\": \"\", \"description\": \"\" }\n}\n}",
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
      const reflectedTitle = innerResponse.title || '';
      const reflectedInstitution = innerResponse.reflected_institution || '';
      const catalogStatus = innerResponse.catalog_status || '';

      // Classification Logic
      let matchType = 'no_match';
      let similarity = 0;
      let isMissingCourse = false;

      const lowerDesc = (description || '').toLowerCase();

      // Step 1: Validate Institution
      let isInstitutionValid = validateInstitution(courseData.institution, reflectedInstitution);

      // Fallback: If AI explicitly says catalog is found, or if we have a significant description
      if (!isInstitutionValid) {
        if (catalogStatus === 'found') {
          isInstitutionValid = true;
        } else if (description && description.length > 50 && !lowerDesc.includes('cannot find')) {
          // If description is long and doesn't look like a "not found" message, trust the catalog exists
          isInstitutionValid = true;
        }
      }

      // Step 2: Check for Catalog Level Failure keywords
      const isMissingCatalogKeyword = !description ||
        lowerDesc.includes('institution not found') ||
        lowerDesc.includes('catalog not found') ||
        lowerDesc.includes('not indexed') ||
        catalogStatus === 'not_indexed' ||
        catalogStatus === 'not_found';

      if (!isInstitutionValid) {
        // User Requirement: Check explicit institution validation for "Catalog Not Found"
        matchType = 'catalog_not_found';
      } else if (isMissingCatalogKeyword) {
        // Also fallback to keywords if the AI explicitly says it can't find the institution
        matchType = 'catalog_not_found';
      } else {
        // Step 3: Course Level Validation
        isMissingCourse = lowerDesc.includes('cannot find') ||
          (description || '').length < 5;

        const hasReflectedCourse = reflectedSubject && reflectedNumber;

        if (isMissingCourse && !hasReflectedCourse) {
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
          number: reflectedNumber,
          title: reflectedTitle
        },
        description: description || 'Course description not available in catalog.',
        description_is_missing: isMissingCourse,
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