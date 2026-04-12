import { describe, expect, it } from "vitest";
import axios from "./lib/utils";

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3001";

describe("GET /", () => {
  it("should check the health endpoint and return healthy", async () => {
    const response = await axios.get(`${BACKEND_URL}/health`);
    expect(response.status).toBe(200);
    expect(response.data).toStrictEqual({
      message: "healthy",
    });
  });

  it("should hit the error endpoint to check the error correctly", async () => {
    const response = await axios.get(`${BACKEND_URL}/error`);
    expect(response.status).toBe(400);
    expect(response.data).toStrictEqual({
      message: "error",
    });
  });
});
