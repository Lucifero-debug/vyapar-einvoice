from dotenv import load_dotenv
load_dotenv()
from pydantic import BaseModel
import os
from PIL import Image
import google.generativeai as genai
from fastapi import FastAPI, HTTPException,UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
import traceback
from schema import InvoiceSchema
import json

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000","https://vyapaar-aspx.vercel.app"], # Your Next.js URL
    allow_methods=["*"],
    allow_headers=["*"],
)

genai.configure(api_key=os.getenv("GOOGLE_API_KEY"))

model=genai.GenerativeModel('gemini-3.1-pro-preview',generation_config={"response_mime_type": "application/json"})

class invoiceRequest(BaseModel):
    image:str

def get_gemini_response(input,image):
    response=model.generate_content([input,image])
    return response.text

def input_image_details(uploaded_file):
    if uploaded_file is not None:
        bytes_data=uploaded_file.getvalue()

        image_parts= [
            {
                "mime_type":uploaded_file.type,
                "data":bytes_data
            }
        ]
        return image_parts
    else:
        raise FileNotFoundError("No File Uploaded")
    

input_prompt=f"""
You are an expert in understanding Invoices. 
Extract all information from the invoice image and format it strictly according to the following JSON schema:
{InvoiceSchema.model_json_schema()}

Rules:
1. Return ONLY valid JSON.
2. If a value is not present in the invoice, leave it as null or an empty list.
3. Ensure all numbers are extracted as floats or integers.
"""

@app.get("/")
def home():
    return {"status": "TalentScout AI is Ready 🚀"}

@app.post("/start")
async def analyze_invoice(file: UploadFile = File(...)):
    try:

        image_bytes = await file.read()

        image_data = {
            "mime_type": file.content_type,
            "data": image_bytes
        }

        response = get_gemini_response(input_prompt, image_data)
        structured_data = json.loads(response)
        validated_invoice = InvoiceSchema(**structured_data)

        return validated_invoice.model_dump(by_alias=True)

    except Exception as e:
        print("ERROR OCCURRED:")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))