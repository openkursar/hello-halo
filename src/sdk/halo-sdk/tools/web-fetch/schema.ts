/**
 * @module tools/web-fetch/schema
 * WebFetch tool description and input schema.
 * @license MIT
 */

export const WEB_FETCH_TOOL_NAME = 'WebFetch';

export const WEB_FETCH_TOOL_DESCRIPTION =
  `Retrieve the text of a web page for inspection. Provide an absolute URL and describe the information you need in prompt; use the returned page text to answer that request.

This fetch has no browser login or service credentials. Use an authenticated integration for private content when one is available. HTML is converted to Markdown and JSON is formatted for reading. No separate summarization model is invoked, and JavaScript-dependent page content may be absent.

HTTP addresses are upgraded to HTTPS. A redirect to another host returns the destination address instead of page content; inspect it before requesting that address. Results may be reused for 15 minutes and are truncated beyond 100,000 characters. Check these limits when freshness or complete coverage matters. Fetching does not save a local file.`;

export const WEB_FETCH_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    url: {
      type: 'string',
      description: 'Absolute address of the page to retrieve.',
      format: 'uri',
    },
    prompt: {
      type: 'string',
      description: 'The question or extraction task to answer from the returned page text.',
    },
  },
  required: ['url', 'prompt'],
} as const;
