/** Unknown controllers and conflicting allow policies fail closed. */
export function kubernetesPolicyEnforced(input: {
  desired: number;
  ready: number;
  mode: string;
  namespaceEgress: Array<{ egress?: unknown[] }>;
  customPolicies: number;
}) {
  return (
    input.desired > 0 &&
    input.ready === input.desired &&
    ["default", "always"].includes(input.mode) &&
    input.customPolicies === 0 &&
    !input.namespaceEgress.some((policy) => (policy.egress?.length ?? 0) > 0)
  );
}
