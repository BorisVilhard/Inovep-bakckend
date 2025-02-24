# Use a Node 14 image (matching your package.json)
FROM node:14

# Set the working directory
WORKDIR /app

# Copy package files first to leverage Docker caching
COPY package*.json ./
RUN npm install

# Copy the rest of your application files
COPY . .

# Expose port 3500 (or whichever port your app listens on)
EXPOSE 3500

# Start the app
CMD ["npm", "start"]
