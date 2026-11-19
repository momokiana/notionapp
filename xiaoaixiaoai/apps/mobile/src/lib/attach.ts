/**
 * Pictures sent with a message to an agent. The phone shrinks each picture
 * (natively, `pickImages`), puts them beside the agent on its computer
 * (`terminal.put`), then sends the text naming their paths through the usual
 * send queue: Claude Code, Codex and the like read a picture from its path.
 */
import { PUT_LIMITS, splitFiles, textWithFiles, type Agent, type RpcResult } from "@xiaoaixiaoai/protocol";
import { XiaoaiNative, type PickedImage } from "../../modules/xiaoaixiaoai-native";
import { call, RelayError } from "./relay";

/** Longest side of a picture sent to an agent; vision models scale larger ones down anyway. */
export const IMAGE_MAX_SIDE = 1600;
const IMAGE_QUALITY = 82;

export interface Attachment extends PickedImage {
  id: string;
}

/** False on app builds from before picture sending (new JS on an old APK). */
export function canPickImages(): boolean {
  return typeof XiaoaiNative?.pickImages === "function";
}

let seq = 0;

/** Up to `room` pictures picked by the person, shrunk to JPEG; [] when they cancel. */
export async function pickImages(room: number): Promise<Attachment[]> {
  if (!XiaoaiNative?.pickImages) throw new Error("这个版本的 App 还不能选图片，更新 App 后再试");
  const picked = await XiaoaiNative.pickImages(Math.max(1, room), IMAGE_MAX_SIDE, IMAGE_QUALITY);
  return picked.map((x) => ({ ...x, id: `img${Date.now().toString(36)}${(seq++).toString(36)}` }));
}

/**
 * The other way round from `textWithFiles`, for showing a message: what the
 * person wrote, the trailing picture lines, and how many pictures they stand for.
 * Shared with the computer, which shows the same preview of waiting messages.
 */
export const splitPictures = splitFiles;

/** Whether a message in the conversation is the one sent from this phone: same words, pictures aside. */
export function sameMessage(said: string, sent: string): boolean {
  return splitPictures(said).text === splitPictures(sent).text;
}

/** Adds newly picked pictures within `PUT_LIMITS`; `note` says what was left out and why. */
export function addPictures(current: Attachment[], picked: Attachment[]): { list: Attachment[]; note?: string } {
  const list = [...current];
  let note: string | undefined;
  let total = list.reduce((n, x) => n + x.bytes, 0);
  for (const x of picked) {
    if (list.length >= PUT_LIMITS.files) {
      note = `一次最多发 ${PUT_LIMITS.files} 张图片`;
      break;
    }
    if (x.bytes > PUT_LIMITS.fileBytes || total + x.bytes > PUT_LIMITS.totalBytes) {
      note = "图片加起来太大了，有的没加上";
      continue;
    }
    list.push(x);
    total += x.bytes;
  }
  return { list, note };
}

/**
 * Sends a message with pictures. Nothing is typed into the agent unless every
 * picture has reached its computer. A computer whose xiaoaixiaoai predates
 * pictures answers `unsupported`, which comes back as a plain reason.
 */
export async function sendWithPictures(agent: Agent, text: string, pictures: Attachment[]): Promise<{ accepted: RpcResult<"terminal.send">; sent: string }> {
  let paths: string[] = [];
  if (pictures.length) {
    try {
      // Pictures are larger than a text: give a slow uplink time to carry them.
      const r = await call(agent.deviceId, "terminal.put", { agent: agent.key, files: pictures.map(({ name, mime, data }) => ({ name, mime, data })) }, 60_000);
      paths = r.paths;
    } catch (e) {
      const err = e as RelayError;
      if (err.code === "unsupported" && /unknown method/i.test(err.message)) {
        throw new RelayError("unsupported", "这台电脑上的 xiaoaixiaoai 版本太旧，还收不了图片，更新后再试");
      }
      throw err;
    }
    if (paths.length !== pictures.length) throw new RelayError("internal", "电脑那边没收全图片，没有发送");
  }
  const sent = textWithFiles(text, paths);
  const accepted = await call(agent.deviceId, "terminal.send", { agent: agent.key, text: sent, enter: true });
  return { accepted, sent };
}
