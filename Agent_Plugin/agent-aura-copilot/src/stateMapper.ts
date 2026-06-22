/**
 * State Mapper - Maps Copilot activity to ESP32 Ring Light agent states.
 *
 * Agent states (from firmware API):
 *   running   - 🟢 Green breath, normal running
 *   busy      - 🟡 Yellow flow, busy processing
 *   waiting   - 🟡 Yellow blink, waiting for approval
 *   error     - 🔴 Red blink, error
 *   idle      - 🔵 Blue breath (fast), 5s auto-off
 *   init      - 🌈 Rainbow, 3s auto-off
 *   offline   - ⚫ Off
 *   upgrade   - 🟠 Orange meteor, upgrading
 */

export type AgentState =
    | 'running'
    | 'busy'
    | 'waiting'
    | 'error'
    | 'idle'
    | 'init'
    | 'offline'
    | 'upgrade';

/**
 * Copilot activity types detected by the watcher.
 */
export type CopilotActivity =
    | 'chat-request'       // User sent a message in Copilot Chat
    | 'chat-response'      // Copilot Chat is streaming a response
    | 'chat-done'          // Chat response completed
    | 'inline-suggesting'  // Inline completion is being generated
    | 'inline-shown'       // Inline suggestion displayed
    | 'inline-accepted'    // User accepted a suggestion
    | 'inline-rejected'    // User rejected/dismissed suggestion
    | 'editing'            // User is actively editing code
    | 'running'            // General running/active state
    | 'idle'               // No activity for a while
    | 'error'              // Something went wrong
    | 'extension-init'     // Extension just activated
    | 'extension-deactivate'; // Extension deactivating

/**
 * Maps a Copilot activity event to the appropriate hardware agent state.
 */
export function mapCopilotToAgent(activity: CopilotActivity): AgentState {
    switch (activity) {
        case 'chat-request':
        case 'chat-response':
            return 'busy';

        case 'inline-suggesting':
            return 'busy';

        case 'chat-done':
        case 'inline-shown':
        case 'inline-accepted':
        case 'editing':
            return 'running';

        case 'inline-rejected':
        case 'running':
            return 'running';

        case 'idle':
            return 'idle';

        case 'error':
            return 'error';

        case 'extension-init':
            return 'init';

        case 'extension-deactivate':
            return 'offline';

        default:
            return 'idle';
    }
}
