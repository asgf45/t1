# NexLoad Android App

This directory contains the source code for the NexLoad Android application, developed in Kotlin.

## Features
- **Standalone App**: No need to use a mobile browser.
- **Embedded Web View**: Loads the NexLoad web interface directly.
- **Download Support**: Integrated with Android's system downloader to save files directly to your device's Downloads folder.
- **Dynamic Server Connection**: Connect to any server IP on your network via the startup dialog.
- **Improved UI**: Includes an "About" tab with developer information.

## How to Build and Run

### Prerequisites
- [Android Studio](https://developer.android.com/studio) Hedgehog | 2023.1.1 or newer.
- JDK 17 (Required for modern Android Gradle Plugin).

### Steps
1. **Open Project**: Launch Android Studio and select "Open" then navigate to the `android-app` directory in this repository.
2. **Sync Gradle**: Android Studio should automatically start syncing Gradle.
3. **Run Server**: Ensure your NexLoad Node.js server is running on your machine (e.g., `npm start` in the root directory).
4. **Run App**: Click the "Run" button in Android Studio.
5. **Connect**: When the app starts, it will ask for the Server URL.
   - **Emulator**: Use the default `http://10.0.2.2:3000`.
   - **Physical Device**: Enter your computer's local IP (e.g., `http://192.168.1.x:3000`).

## Troubleshooting Gradle Errors

If you encounter errors during Gradle sync or build, try these steps:

1. **Check JDK Version**: Ensure Android Studio is using **JDK 17**.
   - Go to `File` > `Settings` (or `Android Studio` > `Settings` on macOS).
   - Navigate to `Build, Execution, Deployment` > `Build Tools` > `Gradle`.
   - Set `Gradle JDK` to version 17.

2. **Invalidate Caches**:
   - Go to `File` > `Invalidate Caches...`.
   - Check all boxes and click `Invalidate and Restart`.

3. **Check Internet Connection**: Gradle needs to download dependencies from Google and Maven Central.

4. **Update Gradle Plugin**: If prompted by Android Studio to update the "Android Gradle Plugin", you can usually accept the update to match your installed version of Android Studio.

## About the Developer
- **Name**: RIfat Mohsin Tapader
- **Email**: kymt83091@gmail.com
