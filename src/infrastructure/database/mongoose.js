import mongoose from "mongoose";
import { CONFIG } from "../../config/index.js";

export async function connectMongo() {
  const uri = CONFIG.mongoUri;
  await mongoose.connect(uri, {
    dbName: new URL(uri).pathname.replace(/^\//, "") || "discord_modbot",
  });
  mongoose.set("strictQuery", true);
  return mongoose.connection;
}
