import type { OrganizationLicense } from "../subscription/_services/billing/types";

export const isBYOKSubscriptionPlan = (license: OrganizationLicense) => {
    if (license.subscriptionStatus === "self-hosted") return true;
    if (license.subscriptionStatus !== "active") return false;
    return license.planType.includes("byok");
};
