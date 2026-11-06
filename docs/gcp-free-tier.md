# GCP free-tier deployment

This setup serves a **public demo**. Visitors can search and view images without an account. Only a holder of the upload token can add images. Use public demo images, since anyone with the URL can see them.

The free tier has limits, not a guaranteed zero bill. Cloud Run, Firestore, and Cloud Storage have free allowances. Artifact Registry, network traffic, logs, and usage beyond allowances can incur charges. Create a budget alert before deployment and keep a small demo library. A large personal photo collection will exceed the free storage allowance.

## 1. Create a project

In the [Google Cloud Console](https://console.cloud.google.com/projectcreate), create a new project with a unique ID. Link a billing account when prompted. Then open the [billing budgets page](https://console.cloud.google.com/billing/budgets) and create a low budget with email alerts. Budget alerts notify you; they do not stop spending.

Install a current Google Cloud CLI, then run:

```bash
gcloud auth login
gcloud config set project PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com firestore.googleapis.com \
  storage.googleapis.com secretmanager.googleapis.com
```

## 2. Create storage and a vector index

Use `us-central1` for Cloud Run, Firestore, and a Standard Cloud Storage bucket. It is one of the regions eligible for Cloud Storage's Always Free allowance. The bucket name must be globally unique.

```bash
gcloud storage buckets create gs://BUCKET_NAME --location=us-central1 \
  --default-storage-class=STANDARD
gcloud firestore databases create --location=us-central1 --type=firestore-native
gcloud firestore indexes composite create \
  --collection-group=images_v1 --query-scope=COLLECTION \
  --field-config='field-path=embedding,vector-config={"dimension":"512","flat":"{}"}'
```

Wait until the Firestore index reports ready before searching. Firestore stores the 512-dimensional CLIP vectors and metadata; GCS stores original image files.

## 3. Grant the app access

Create a dedicated runtime service account. Grant it Firestore data access and object access only on the demo bucket. Create a long random upload token in a password manager, then add it as a secret named `typeandsee-upload-token` in the [Secret Manager Console](https://console.cloud.google.com/security/secret-manager). Grant the runtime account access to that secret.

```bash
gcloud iam service-accounts create typeandsee
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member=serviceAccount:typeandsee@PROJECT_ID.iam.gserviceaccount.com \
  --role=roles/datastore.user
gcloud storage buckets add-iam-policy-binding gs://BUCKET_NAME \
  --member=serviceAccount:typeandsee@PROJECT_ID.iam.gserviceaccount.com \
  --role=roles/storage.objectUser
gcloud secrets add-iam-policy-binding typeandsee-upload-token \
  --member=serviceAccount:typeandsee@PROJECT_ID.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor
```

Keep the token in your password manager. Enter it in the app's upload panel when adding images.

## 4. Deploy

From the repository root:

```bash
gcloud run deploy typeandsee --source . --region us-central1 \
  --service-account typeandsee@PROJECT_ID.iam.gserviceaccount.com \
  --allow-unauthenticated --memory 4Gi --cpu 2 --timeout 300 \
  --min-instances 0 --max-instances 1 --concurrency 1 \
  --set-env-vars GCS_BUCKET=BUCKET_NAME,VECTOR_BACKEND=firestore,APP_REQUIRE_UPLOAD_AUTH=true \
  --set-secrets APP_API_TOKEN=typeandsee-upload-token:latest
```

The service URL is public. Search and image viewing are public. Uploads need the token. The first search or upload downloads the CLIP weights and may be slow. The app currently runs CPU inference. Leave `GEMINI_API_KEY` unset to avoid explanation-model charges; the explanation option stays hidden until it is configured.

## 5. Verify and watch usage

Open the Cloud Run URL, upload one demo image with the token, and search for it. Review Cloud Run logs and the billing dashboard after the test. The `--max-instances 1` setting limits concurrent server instances, but it is not a spending cap. If you need strict zero-cost behavior, do not deploy a public service without an external hard usage control.
