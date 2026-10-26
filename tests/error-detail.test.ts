// A caller-supplied field name must not come back in a challenge shape error.
// PHP interpolated it until 650c81a. The Node checker still concatenated the key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { assertChallengeShape } from "../packages/protocol/src/index.ts";
import { TollError } from "../packages/protocol/src/errors.ts";

const git = (spec: string) => execFileSync("git", ["show", spec], { encoding: "utf8" });
const ECHO = [/unknown field\s*\$/, /"unknown field "\s*\+/];

function echoesField(src: string) {
  return ECHO.some((re) => re.test(src));
}

test("assertChallengeShape does not echo the unknown field name", () => {
  assert.throws(
    () => assertChallengeShape({ nope_field: 1 }),
    (e: unknown) => {
      assert.ok(e instanceof TollError);
      assert.equal(e.code, "malformed");
      assert.equal(e.message, "unknown field");
      assert.equal(e.message.includes("nope_field"), false);
      return true;
    },
  );
});

test("current Node and PHP sources do not interpolate the field name", () => {
  assert.equal(echoesField(readFileSync("packages/protocol/src/challenge.ts", "utf8")), false);
  assert.equal(echoesField(readFileSync("packages/server-php/src/Toll.php", "utf8")), false);
  const php = execFileSync("php", ["-r", `
    require "packages/server-php/vendor/autoload.php";
    try {
      Toll\\Protocol::assertChallengeShape(["nope_field" => 1]);
      fwrite(STDERR, "no throw\\n");
      exit(1);
    } catch (Toll\\TollError $e) {
      if ($e->codeName !== "malformed" || $e->getMessage() !== "unknown field" || str_contains($e->getMessage(), "nope_field")) exit(1);
      echo "ok\\n";
    }
  `], { encoding: "utf8" });
  assert.equal(php.trim(), "ok");
});

test("650c81a parent: PHP echoed the field name", () => {
  const src = git("650c81a^:packages/server-php/src/Toll.php");
  assert.equal(echoesField(src), true);
  assert.match(src, /unknown field \$k/);
});

test("5cd9c85: Node still concatenated the field name", () => {
  const src = git("5cd9c85:packages/protocol/src/challenge.ts");
  assert.equal(echoesField(src), true);
  assert.match(src, /"unknown field " \+ k/);
});
