import { fromNodeHeaders } from "better-auth/node";
import { NextFunction, Request, Response } from "express";
import { auth } from "../lib/auth";

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  if (session) {
    req.userId = session.user.id;
    next();
  } else {
    return res.status(403).json({
      message: "unauthrized",
    });
  }
}
