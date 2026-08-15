from PIL import Image

# Open the PNG image
png_image = Image.open('Untitled.jpg')

# Convert and save it as an ICO file
png_image.save('icon.ico', format='ICO')
