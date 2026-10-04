package dev.qajitsu.demoshop;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Scanner;

/** In-memory cart and the configuration read from the demo-shop API. */
final class Shop {
  static int items = 0;
  static volatile boolean backEmptiesCart = false;
  static volatile boolean configLoaded = false;

  private Shop() {}

  /** Reads GET {api}/app-config once; the API URL comes from the launch intent (default: the host's port 3000). */
  static void loadConfig(final String api) {
    if (configLoaded) return;
    Thread t = new Thread(() -> {
      try {
        HttpURLConnection c = (HttpURLConnection) new URL(api + "/app-config").openConnection();
        c.setConnectTimeout(5000);
        c.setReadTimeout(5000);
        try (InputStream in = c.getInputStream(); Scanner s = new Scanner(in, "UTF-8")) {
          String body = s.useDelimiter("\\A").hasNext() ? s.next() : "";
          backEmptiesCart = body.replace(" ", "").contains("\"backEmptiesCart\":true");
        }
      } catch (Exception e) {
        backEmptiesCart = false;
      }
      configLoaded = true;
    });
    t.start();
    try {
      t.join(6000);
    } catch (InterruptedException ignored) {
      Thread.currentThread().interrupt();
    }
  }

  static String label(int n) {
    return "Cart: " + n + (n == 1 ? " item" : " items");
  }
}
