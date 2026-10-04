package dev.qajitsu.demoshop;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Cart screen: shows the item count, adds an item, opens checkout. */
public class CartActivity extends Activity {
  private TextView count;

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    String api = getIntent().getStringExtra("api_url");
    Shop.loadConfig(api == null ? "http://10.0.2.2:3000" : api);
    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setPadding(48, 96, 48, 48);
    TextView title = new TextView(this);
    title.setText("demo-shop");
    title.setTextSize(24);
    count = new TextView(this);
    count.setContentDescription("cart-count");
    count.setTextSize(20);
    Button add = new Button(this);
    add.setText("Add sticker");
    add.setContentDescription("add-item");
    add.setOnClickListener(v -> {
      Shop.items += 1;
      refresh();
    });
    Button checkout = new Button(this);
    checkout.setText("Checkout");
    checkout.setContentDescription("open-checkout");
    checkout.setOnClickListener(v -> startActivity(new Intent(this, CheckoutActivity.class)));
    root.addView(title);
    root.addView(count);
    root.addView(add);
    root.addView(checkout);
    setContentView(root);
  }

  @Override
  protected void onResume() {
    super.onResume();
    refresh();
  }

  private void refresh() {
    count.setText(Shop.label(Shop.items));
  }
}
