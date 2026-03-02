import { Request, Response, NextFunction } from "express";
import { z } from "zod";

export interface Identity {
  orgId: string;
  userId: string;
}

const uuidSchema = z.string().uuid();

export const requireIdentity = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const rawOrgId = req.headers["x-org-id"];
  const rawUserId = req.headers["x-user-id"];

  if (
    typeof rawOrgId !== "string" ||
    !uuidSchema.safeParse(rawOrgId).success
  ) {
    res
      .status(400)
      .json({ error: "x-org-id header is required and must be a valid UUID" });
    return;
  }

  if (
    typeof rawUserId !== "string" ||
    !uuidSchema.safeParse(rawUserId).success
  ) {
    res
      .status(400)
      .json({ error: "x-user-id header is required and must be a valid UUID" });
    return;
  }

  (req as Request & { identity: Identity }).identity = {
    orgId: rawOrgId,
    userId: rawUserId,
  };
  next();
};

export const getIdentity = (req: Request): Identity => {
  return (req as Request & { identity: Identity }).identity;
};
