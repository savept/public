const BLOCKED = "WORKSPACE_POLICY_BLOCKED";

function block(message) {
  throw new Error(`${BLOCKED}: ${message}`);
}

export { BLOCKED, block };
