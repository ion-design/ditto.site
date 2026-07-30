import webview
import json
import urllib.request
import urllib.error
import tarfile
import os
import io
import threading
import time

class DittoAPI:
    def __init__(self):
        self._window = None

    def set_window(self, window):
        self._window = window

    def log(self, message):
        """Pushes real-time log messages to the frontend 8-bit terminal"""
        if self._window:
            # Escape quotes and backslashes for safe JS execution
            clean_msg = message.replace('\\', '\\\\').replace("'", "\\'").replace('\n', ' ')
            self._window.evaluate_js(f"appendLog('{clean_msg}');")

    def request_api_key(self, email):
        """Handles requesting a new API key via email"""
        if not email:
            return {"success": False, "error": "Email is required."}
        
        url = "https://api.ditto.site/v1/signup/request"
        data = json.dumps({"email": email}).encode('utf-8')
        req = urllib.request.Request(
            url, 
            data=data, 
            headers={"Content-Type": "application/json"}, 
            method="POST"
        )
        
        try:
            with urllib.request.urlopen(req) as response:
                return {"success": True, "message": f"Key requested for {email}! Check inbox."}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def start_clone_job(self, api_key, target_url, folder, mode, framework):
        """Spawns a background thread to handle the long-running clone process"""
        threading.Thread(
            target=self._run_clone_process,
            args=(api_key, target_url, folder, mode, framework),
            daemon=True
        ).start()
        return {"status": "started"}

    def _run_clone_process(self, api_key, target_url, folder, mode, framework):
        self.log(f"🚀 Submitting request to clone {target_url}...")
        self.log(f"   Mode: {mode} | Framework: {framework} | Styling: tailwind")

        # 1. Submit Clone Job
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        payload = json.dumps({
            "url": target_url,
            "options": {
                "mode": mode,
                "framework": framework,
                "styling": "tailwind"
            }
        }).encode('utf-8')

        req = urllib.request.Request("https://api.ditto.site/v1/clones", data=payload, headers=headers, method="POST")
        
        try:
            with urllib.request.urlopen(req) as resp:
                res_json = json.loads(resp.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            err_msg = e.read().decode('utf-8') if e.fp else str(e)
            self.log(f"❌ Failed to create clone job: {err_msg}")
            self.log("PROCESS_FAILED")
            return
        except Exception as e:
            self.log(f"❌ Error submitting clone job: {str(e)}")
            self.log("PROCESS_FAILED")
            return

        job_id = res_json.get("jobId") or res_json.get("id")
        if not job_id:
            self.log(f"❌ Could not retrieve Job ID from server response.")
            self.log("PROCESS_FAILED")
            return

        self.log(f"✅ Job Created! ID: {job_id}")
        self.log("⏳ Waiting for Ditto servers to process and build components...")

        # 2. Poll Job Status
        poll_url = f"https://api.ditto.site/v1/clones/{job_id}"
        
        while True:
            time.sleep(5)
            poll_req = urllib.request.Request(poll_url, headers={"Authorization": f"Bearer {api_key}"})
            try:
                with urllib.request.urlopen(poll_req) as resp:
                    status_json = json.loads(resp.read().decode('utf-8'))
                    status = status_json.get("status", "running")
            except Exception as e:
                self.log(f"⚠️ Error polling status: {str(e)}. Retrying...")
                continue

            self.log(f"   └─ Status: {status}")

            if status in ["succeeded", "completed"]:
                self.log("🎉 Clone finished successfully on server!")
                break
            elif status == "failed":
                self.log("❌ Job failed on Ditto's servers.")
                self.log("PROCESS_FAILED")
                return

        # 3. Download & Extract Archive (.tar.gz / .tgz)
        self.log(f"📦 Downloading bundle and extracting into './{folder}'...")
        bundle_url = f"https://api.ditto.site/v1/clones/{job_id}/bundle?format=tgz"
        bundle_req = urllib.request.Request(bundle_url, headers={"Authorization": f"Bearer {api_key}"})

        try:
            with urllib.request.urlopen(bundle_req) as resp:
                bundle_bytes = resp.read()
                
            os.makedirs(folder, exist_ok=True)
            
            # Extract tarball directly from memory buffer
            with tarfile.open(fileobj=io.BytesIO(bundle_bytes), mode="r:gz") as tar:
                tar.extractall(path=folder)

            self.log("==========================================")
            self.log(f"✨ All set! Project extracted to ./{folder}")
            self.log("To run your app, execute in terminal:")
            self.log(f"  cd {folder}")
            self.log("  npm install")
            self.log("  npm run dev")
            self.log("==========================================")
            self.log("PROCESS_SUCCESS")

        except Exception as e:
            self.log(f"❌ Download/Extraction failed: {str(e)}")
            self.log("PROCESS_FAILED")

if __name__ == '__main__':
    api = DittoAPI()
    
    window = webview.create_window(
        title='Ditto Website Cloner Desktop',
        url='gui/index.html',
        js_api=api,
        width=1150,
        height=820,
        resizable=True
    )
    
    api.set_window(window)
    webview.start(debug=True)