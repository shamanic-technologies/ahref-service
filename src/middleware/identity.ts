import { Request } from "express";
import { z } from "zod";

export interface Identity {
  orgId?: string;
  userId?: string;
}

const uuidSchema = z.string().uuid();

export const extractIdentity = (req: Request): Identity => {
  const rawOrgId = req.headers["x-org-id"];
  const rawUserId = req.headers["x-user-id"];

  const orgId =
    typeof rawOrgId === "string" && uuidSchema.safeParse(rawOrgId).success
      ? rawOrgId
      : undefined;

  const userId =
    typeof rawUserId === "string" && uuidSchema.safeParse(rawUserId).success
      ? rawUserId
      : undefined;

  return { orgId, userId };
};
