import { Request, Response, NextFunction } from "express";

export const authMiddleware = (apiKey: string) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const provided = req.headers["x-api-key"];
    if (!provided || provided !== apiKey) {
      res.status(401).json({ error: "Unauthorized: invalid or missing x-api-key" });
      return;
    }
    next();
  };
};
