package dev.qajitsu.demoshop;

import android.app.Activity;
import android.os.Bundle;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Checkout screen: shows what will be ordered. Back returns to the cart, which must keep its items. */
public class CheckoutActivity extends Activity {
  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setPadding(48, 96, 48, 48);
    TextView title = new TextView(this);
    title.setText("Checkout");
    title.setContentDescription("checkout-title");
    title.setTextSize(24);
    TextView summary = new TextView(this);
    summary.setText("Items to order: " + Shop.items);
    summary.setContentDescription("checkout-items");
    root.addView(title);
    root.addView(summary);
    setContentView(root);
  }

  @Override
  public void onBackPressed() {
    // BUG-08 (BUG_ANDROID_BACK_EMPTIES_CART): leaving checkout with the back button empties the cart.
    if (Shop.backEmptiesCart) Shop.items = 0;
    super.onBackPressed();
  }
}
