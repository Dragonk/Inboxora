import { GRAPH_API_BASE, graphPostRawBody, type GraphApiOptions } from './graphApiClient.js';

/**
 * Send a composed message over Microsoft Graph.
 *
 * The message is the **already composed MIME** the send route built and measured, not a re-mapping
 * of nodemailer's options: Graph accepts a MIME body, and mapping recipients and inline images
 * onto its JSON `message` shape would re-implement composition that is correct and tested —
 * including the envelope's blind recipients, which are by definition not in the headers.
 *
 * The envelope is **not** passed here. Graph derives the recipients from the message headers, so a
 * blind recipient would be lost or exposed by the MIME alone; the caller therefore sends the
 * envelope separately once the upload-session path lands, and this function is the direct-send case
 * only, where the route already refused to reach it with a blind recipient in the headers.
 */
export async function sendGraphMime(api: GraphApiOptions, mime: Buffer): Promise<void> {
  await graphPostRawBody(api, '/me/sendMail', {
    contentType: 'text/plain',
    body: mime.toString('base64'),
  });
}

export const GRAPH_SEND_MAIL_URL = `${GRAPH_API_BASE}/me/sendMail`;
