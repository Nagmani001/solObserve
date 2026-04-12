import { server } from "..";

export function shutdown(code = 0) {
  console.log("Shutting down gracefully...");
  server.close(() => {
    process.exit(code);
  });
  setTimeout(() => {
    process.exit(code);
  }, 5000);
}
