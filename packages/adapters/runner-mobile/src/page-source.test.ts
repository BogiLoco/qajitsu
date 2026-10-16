import { describe, expect, it } from "vitest";
import { pageSourceElements } from "./page-source.js";

describe("elements from the Appium page source (REQ-EXEC-22/AC1)", () => {
  it("REQ-EXEC-22/AC1: Android: accessibility id, resource id, text, class and state", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <android.widget.FrameLayout index="0" package="dev.qajitsu.demoshop" class="android.widget.FrameLayout" text="" displayed="true">
    <android.widget.TextView index="0" class="android.widget.TextView" text="Cart: 0 items" content-desc="cart-count" resource-id="" enabled="true" displayed="true"/>
    <android.widget.Button class="android.widget.Button" text="Add item" content-desc="add-item" resource-id="dev.qajitsu.demoshop:id/add_item" enabled="true" checked="false" displayed="true"/>
    <android.widget.Button class="android.widget.Button" text="Pay &amp; go" content-desc="" resource-id="dev.qajitsu.demoshop:id/pay" enabled="false" displayed="true"/>
    <android.widget.CheckBox class="android.widget.CheckBox" text="Terms" checked="true" displayed="true"/>
    <android.widget.TextView class="android.widget.TextView" text="Hidden" displayed="false"/>
    <android.view.View class="android.view.View" text="" content-desc="" resource-id=""/>
  </android.widget.FrameLayout>
</hierarchy>`;
    expect(pageSourceElements(xml, "android")).toEqual([
      { role: "TextView", testid: "cart-count", text: "Cart: 0 items" },
      { role: "Button", testid: "add-item", resourceId: "add_item", text: "Add item" },
      { role: "Button", resourceId: "pay", text: "Pay & go", disabled: true },
      { role: "CheckBox", text: "Terms", checked: true },
    ]);
  });

  it("REQ-EXEC-22/AC1: iOS: identifier, label, value, type and state", () => {
    const xml = `<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Shop" label="Shop" enabled="true" visible="true">
  <XCUIElementTypeButton type="XCUIElementTypeButton" name="add-item" label="Add item" enabled="true" visible="true"/>
  <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="Cart: 0 items" label="Cart: 0 items" value="Cart: 0 items" enabled="true" visible="true"/>
  <XCUIElementTypeButton type="XCUIElementTypeButton" name="pay" label="Pay" enabled="false" visible="true"/>
  <XCUIElementTypeOther type="XCUIElementTypeOther" enabled="true" visible="true"/>
  <XCUIElementTypeButton type="XCUIElementTypeButton" name="gone" label="Gone" visible="false"/>
</XCUIElementTypeApplication></AppiumAUT>`;
    expect(pageSourceElements(xml, "ios")).toEqual([
      { role: "Application", testid: "Shop", text: "Shop" },
      { role: "Button", testid: "add-item", text: "Add item" },
      { role: "StaticText", testid: "Cart: 0 items", text: "Cart: 0 items" },
      { role: "Button", testid: "pay", text: "Pay", disabled: true },
    ]);
  });

  it("REQ-EXEC-22/AC2: a page source that is not XML gives no elements", () => {
    expect(pageSourceElements("", "android")).toEqual([]);
    expect(pageSourceElements("error: no session", "ios")).toEqual([]);
  });
});
